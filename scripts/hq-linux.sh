#!/usr/bin/env bash
# HQ fork: runs this checkout's T3 Code server on Linux as a systemd user service.
#
#   scripts/hq-linux.sh install               build, install the service, start it, print a pairing link
#   scripts/hq-linux.sh update                fast-forward to origin/$T3HQ_BRANCH, rebuild, restart
#   scripts/hq-linux.sh pair [t3 pair args]   print a fresh pairing link
#   scripts/hq-linux.sh import-rooms <bundle> add rooms and shelves exported from another machine
#   scripts/hq-linux.sh status | logs | uninstall
#
# Upstream's `t3 service install` only runs downloaded releases, so this keeps its own unit,
# t3code-hq.service, and leaves t3code.service alone. Uninstalling keeps all data.
#
# Settings: T3HQ_PORT (3773), T3HQ_HOST (all interfaces), T3HQ_BRANCH (main), T3CODE_HOME (~/.t3).
# Needs git, a C toolchain and python3 (native modules), and vp (https://vite.plus) for Node and pnpm.
set -euo pipefail

UNIT=t3code-hq.service
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PORT=${T3HQ_PORT:-3773}
HOST=${T3HQ_HOST:-}
BRANCH=${T3HQ_BRANCH:-main}
T3_HOME=${T3CODE_HOME:-$HOME/.t3}
UNIT_FILE=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT
SERVER=$ROOT/apps/server/dist/bin.mjs
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

check_tools() {
  need git "Install git."
  need vp "Install it with: curl -fsSL https://vite.plus | bash"
  need cc "Install a C toolchain (build-essential on Debian/Ubuntu)."
  need python3 "Install python3."
  need curl "Install curl."
  user_ctl show-environment >/dev/null 2>&1 || die "systemd user services are unavailable (systemctl --user)."
}

build() {
  say "Installing dependencies"
  (cd "$ROOT" && vp install --frozen-lockfile)
  say "Building server and web app"
  (cd "$ROOT" && vp run --filter t3 build)
  [[ -f $SERVER && -f $ROOT/apps/server/dist/client/index.html ]] || die "the build did not produce $SERVER and its web app."
}

write_unit() {
  local node args
  node=$(node_bin)
  args="serve --port $PORT --base-dir \"$T3_HOME\""
  [[ -n $HOST ]] && args+=" --host $HOST"
  mkdir -p "$(dirname "$UNIT_FILE")"
  # PATH is the installing shell's, so agents find the same claude, codex, gh and git.
  cat >"$UNIT_FILE" <<EOF
[Unit]
Description=T3 Code HQ (built from $ROOT)
Wants=network-online.target
After=network-online.target

[Service]
WorkingDirectory=%h
Environment="PATH=$PATH"
Environment="T3CODE_HOME=$T3_HOME"
ExecStart="$node" "$SERVER" $args
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
EOF
  user_ctl daemon-reload
}

wait_ready() {
  local url=http://127.0.0.1:$PORT/.well-known/t3/environment
  for _ in $(seq 1 90); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      say "Running on port $PORT"
      return
    fi
    user_ctl is-failed --quiet "$UNIT" && break
    sleep 1
  done
  user_ctl status "$UNIT" --no-pager --lines 30 || true
  die "the server did not come up on port $PORT. See: $0 logs"
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
    user_ctl enable --now "$UNIT"
    enable_linger
    wait_ready
    pair
    ;;
  update)
    check_tools
    [[ -f $UNIT_FILE ]] || die "not installed. Run: $0 install"
    cd "$ROOT"
    [[ $(git rev-parse --abbrev-ref HEAD) == "$BRANCH" ]] || die "the checkout is not on $BRANCH."
    git diff --quiet && git diff --cached --quiet || die "the checkout has uncommitted changes."
    before=$(git rev-parse --short HEAD)
    git fetch --quiet origin "$BRANCH"
    git merge --ff-only --quiet "origin/$BRANCH"
    after=$(git rev-parse --short HEAD)
    if [[ $before == "$after" && ${2:-} != --force ]]; then
      say "Already at $after. Pass --force to rebuild anyway."
      exit 0
    fi
    build
    write_unit
    say "Restarting (running agent turns are interrupted)"
    user_ctl restart "$UNIT"
    wait_ready
    say "Updated $before -> $after. To go back: git -C $ROOT reset --hard $before && $0 update --force"
    ;;
  pair)
    shift
    pair "$@"
    ;;
  import-rooms)
    bundle=${2:-}
    [[ -f $bundle/rooms.sql ]] || die "usage: $0 import-rooms <bundle dir with rooms.sql and shelves/>"
    db=$T3_HOME/userdata/statev2.sqlite
    [[ -f $db ]] || die "no database at $db yet. Run $0 install first."
    say "Stopping the server to import"
    user_ctl stop "$UNIT"
    if [[ -d $bundle/shelves ]]; then
      mkdir -p "$T3_HOME/userdata/shelves"
      # Existing shelf files win; the rows are INSERT OR IGNORE for the same reason.
      cp -a -n "$bundle/shelves/." "$T3_HOME/userdata/shelves/"
    fi
    (cd "$ROOT" && node -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec(require("node:fs").readFileSync(process.argv[2], "utf8"));
      const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
      console.log(`${count("hq_rooms")} rooms, ${count("hq_room_documents")} shelf rows`);
    ' "$db" "$bundle/rooms.sql")
    user_ctl start "$UNIT"
    wait_ready
    ;;
  status)
    user_ctl status "$UNIT" --no-pager --lines 0 || true
    curl -fsS "http://127.0.0.1:$PORT/.well-known/t3/environment" && echo
    ;;
  logs)
    journalctl --user -u "$UNIT" -f
    ;;
  uninstall)
    user_ctl disable --now "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_FILE"
    user_ctl daemon-reload
    say "Removed $UNIT. Data in $T3_HOME is untouched."
    ;;
  *)
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
