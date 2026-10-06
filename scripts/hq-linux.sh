#!/usr/bin/env bash
# HQ fork: runs this checkout's T3 Code server on Linux as a systemd user service.
#
#   scripts/hq-linux.sh install               build, install the service, start it, print a pairing link
#   scripts/hq-linux.sh update                fast-forward to origin/$T3HQ_BRANCH, rebuild, restart
#   scripts/hq-linux.sh rebuild               rebuild and restart whatever is checked out
#   scripts/hq-linux.sh pair [t3 pair args]   print a fresh pairing link; --tailscale gives an HTTPS tailnet one
#   scripts/hq-linux.sh import-rooms <bundle> add rooms and shelves exported from another machine
#   scripts/hq-linux.sh status | logs | uninstall
#
# Upstream's `t3 service install` only runs downloaded releases, so this keeps its own unit,
# t3code-hq.service, and leaves t3code.service alone. Uninstalling keeps all data.
#
# Settings: T3HQ_PORT (3773), T3HQ_HOST (127.0.0.1; 0.0.0.0 for the LAN), T3HQ_BRANCH (main),
# T3CODE_HOME (~/.t3).
# Install remembers them; set one again on a later command to change it.
# Needs git, a C toolchain and python3 (native modules), and vp (https://vite.plus) for Node and pnpm.
set -euo pipefail

UNIT=t3code-hq.service
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}
UNIT_FILE=$CONFIG_DIR/systemd/user/$UNIT
SETTINGS=$CONFIG_DIR/t3code-hq.env
# Settings saved by the last successful build; ones set in the environment win.
if [[ -f $SETTINGS ]]; then
  while IFS='=' read -r key value; do
    case $key in
      T3HQ_PORT | T3HQ_HOST | T3HQ_BRANCH | T3CODE_HOME | T3HQ_DEPLOYED)
        [[ -n ${!key+set} ]] || export "$key=$value"
        ;;
    esac
  done <"$SETTINGS"
fi
PORT=${T3HQ_PORT:-3773}
HOST=${T3HQ_HOST:-}
BRANCH=${T3HQ_BRANCH:-main}
T3_HOME=${T3CODE_HOME:-$HOME/.t3}
DEPLOYED=${T3HQ_DEPLOYED:-}
# The service runs a copy of the build, so a failed rebuild leaves it intact. It sits under
# apps/server (gitignored) so the server's native modules still resolve from its node_modules.
RELEASE=$ROOT/apps/server/release
SERVER=$RELEASE/current/bin.mjs
# systemctl --user needs the user bus, which a non-login shell (cron, some ssh setups) lacks.
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() {
  printf 'hq-linux: %s\n' "$*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null || die "$1 is missing. $2"; }
user_ctl() { systemctl --user "$@"; }
# The vp shim picks the Node version this checkout pins; the unit gets the real binary.
node_bin() { (cd "$ROOT" && node -p process.execPath); }
# A quoted systemd value: % starts a specifier; in ExecStart, $ also expands variables.
unit_value() {
  local value=${1//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  printf '"%s"' "$value"
}
unit_arg() { unit_value "${1//\$/\$\$}"; }

check_tools() {
  need git "Install git."
  need vp "Install it with: curl -fsSL https://vite.plus | bash"
  need cc "Install a C toolchain (build-essential on Debian/Ubuntu)."
  need python3 "Install python3."
  need curl "Install curl."
  user_ctl show-environment >/dev/null 2>&1 || die "systemd user services are unavailable (systemctl --user)."
}

build() {
  local dist=$ROOT/apps/server/dist
  say "Installing dependencies"
  (cd "$ROOT" && vp install --frozen-lockfile)
  say "Building server and web app"
  (cd "$ROOT" && vp run --filter t3 build)
  [[ -f $dist/bin.mjs && -f $dist/client/index.html ]] || die "the build did not produce $dist/bin.mjs and its web app."
  rm -rf "$RELEASE/next" "$RELEASE/old"
  mkdir -p "$RELEASE"
  cp -a "$dist" "$RELEASE/next"
  if [[ -d $RELEASE/current ]]; then mv "$RELEASE/current" "$RELEASE/old"; fi
  mv "$RELEASE/next" "$RELEASE/current"
  rm -rf "$RELEASE/old"
}

write_unit() {
  local command
  command="$(unit_arg "$(node_bin)") $(unit_arg "$SERVER") serve --port $(unit_arg "$PORT")"
  command+=" --base-dir $(unit_arg "$T3_HOME")"
  [[ -n $HOST ]] && command+=" --host $(unit_arg "$HOST")"
  mkdir -p "$(dirname "$UNIT_FILE")"
  # PATH is the installing shell's, so agents find the same claude, codex, gh and git.
  cat >"$UNIT_FILE" <<EOF
[Unit]
Description=T3 Code HQ
Wants=network-online.target
After=network-online.target

[Service]
WorkingDirectory=%h
Environment=$(unit_value "PATH=$PATH")
Environment=$(unit_value "T3CODE_HOME=$T3_HOME")
ExecStart=$command
Restart=always
RestartSec=5
# The server exits 130 after a clean shutdown on SIGTERM.
SuccessExitStatus=130 143
KillMode=mixed
TimeoutStopSec=30
# An agent's command killed for memory must not take the server down with it.
OOMPolicy=continue

[Install]
WantedBy=default.target
EOF
  user_ctl daemon-reload
}

save_settings() {
  DEPLOYED=$(git -C "$ROOT" rev-parse --short HEAD)
  printf '%s\n' "T3HQ_PORT=$PORT" "T3HQ_HOST=$HOST" "T3HQ_BRANCH=$BRANCH" "T3CODE_HOME=$T3_HOME" \
    "T3HQ_DEPLOYED=$DEPLOYED" >"$SETTINGS"
}

environment_url() {
  local host=127.0.0.1
  case $HOST in
    "" | 0.0.0.0 | ::) ;;
    *:*) host="[$HOST]" ;;
    *) host=$HOST ;;
  esac
  echo "http://$host:$PORT/.well-known/t3/environment"
}

# Ready means this fork answers: upstream's server on the same port has no rooms.
wait_ready() {
  local url body
  url=$(environment_url)
  for _ in $(seq 1 90); do
    body=$(curl -fsS --max-time 3 "$url" 2>/dev/null) || body=
    if [[ $body == *'"rooms":true'* ]]; then
      say "Running on port $PORT"
      return
    fi
    user_ctl is-failed --quiet "$UNIT" && break
    sleep 1
  done
  user_ctl status "$UNIT" --no-pager --lines 30 || true
  die "the server did not come up at $url, or another server holds the port. See: $0 logs"
}

pair() { node "$SERVER" pair --base-dir "$T3_HOME" "$@"; }

enable_linger() {
  [[ $(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null) == yes ]] && return
  loginctl enable-linger "$(id -un)" 2>/dev/null && return
  say "To keep T3 Code running after you log out, run once:"
  echo "  sudo loginctl enable-linger $(id -un)"
}

case ${1:-} in
  install)
    check_tools
    build
    write_unit
    user_ctl enable "$UNIT"
    user_ctl restart "$UNIT"
    enable_linger
    wait_ready
    save_settings
    pair
    say "On a tailnet, $ROOT/scripts/hq-linux.sh pair --tailscale publishes it over HTTPS and links to that."
    ;;
  update)
    check_tools
    [[ -f $UNIT_FILE ]] || die "not installed. Run: $0 install"
    cd "$ROOT"
    [[ $(git rev-parse --abbrev-ref HEAD) == "$BRANCH" ]] || die "the checkout is not on $BRANCH."
    if ! git diff --quiet || ! git diff --cached --quiet; then
      die "the checkout has uncommitted changes."
    fi
    git fetch --quiet origin "$BRANCH"
    git merge --ff-only --quiet "origin/$BRANCH"
    head=$(git rev-parse --short HEAD)
    if [[ $head == "$DEPLOYED" ]]; then
      say "Already running $head. To rebuild anyway: $0 rebuild"
      exit 0
    fi
    say "Updating ${DEPLOYED:-an unknown build} -> $head."
    [[ -n $DEPLOYED ]] && say "To go back: git -C $ROOT reset --hard $DEPLOYED && $ROOT/scripts/hq-linux.sh rebuild"
    # The merge may have changed this script; bash keeps running the version it already read.
    exec "$ROOT/scripts/hq-linux.sh" rebuild
    ;;
  rebuild)
    check_tools
    [[ -f $UNIT_FILE ]] || die "not installed. Run: $0 install"
    build
    write_unit
    say "Restarting (running agent turns are interrupted)"
    user_ctl restart "$UNIT"
    wait_ready
    save_settings
    ;;
  pair)
    shift
    pair "$@"
    ;;
  import-rooms)
    bundle=$(cd "${2:-}" 2>/dev/null && pwd) || bundle=
    [[ -f $bundle/rooms.sql ]] || die "usage: $0 import-rooms <bundle dir with rooms.sql and shelves/>"
    db=$T3_HOME/userdata/statev2.sqlite
    [[ -f $db ]] || die "no database at $db yet. Run $0 install first."
    say "Stopping the server to import"
    user_ctl stop "$UNIT"
    trap 'user_ctl start "$UNIT"' EXIT
    if [[ -d $bundle/shelves ]]; then
      mkdir -p "$T3_HOME/userdata/shelves"
      # Existing shelf files win; the rows are INSERT OR IGNORE for the same reason.
      cp -a -n "$bundle/shelves/." "$T3_HOME/userdata/shelves/"
    fi
    # shellcheck disable=SC2016 # the ${...} below is JavaScript
    (cd "$ROOT" && node -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec(require("node:fs").readFileSync(process.argv[2], "utf8"));
      const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
      console.log(`${count("hq_rooms")} rooms, ${count("hq_room_documents")} shelf rows`);
    ' "$db" "$bundle/rooms.sql")
    trap - EXIT
    user_ctl start "$UNIT"
    wait_ready
    ;;
  status)
    user_ctl status "$UNIT" --no-pager --lines 0 || true
    [[ -n $DEPLOYED ]] && echo "Built from $DEPLOYED"
    curl -fsS --max-time 3 "$(environment_url)" && echo
    ;;
  logs)
    journalctl --user -u "$UNIT" -f
    ;;
  uninstall)
    user_ctl disable --now "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_FILE" "$SETTINGS"
    user_ctl daemon-reload
    say "Removed $UNIT. Data in $T3_HOME is untouched."
    ;;
  *)
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
