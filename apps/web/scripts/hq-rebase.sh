#!/bin/sh
# HQ fork: move the fork's commits onto the T3 release the desktop app runs, check them, and push.
# Prints "current" and exits 0 when there is nothing to do. On a conflict it stops with the rebase in
# progress: resolve it, `git rebase --continue`, and rerun; `hq-before-<version>` keeps the previous main.
set -e
cd "$(git rev-parse --show-toplevel)"
pnpm() { mise exec node@24.18.0 -- npx -y pnpm@11.10.0 "$@"; }

version=$(curl -fsS "http://127.0.0.1:${T3CODE_PORT:-3773}/.well-known/t3/environment" |
  node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).serverVersion')
target="v$version"
git fetch -q origin
git fetch -q upstream --tags
if git merge-base --is-ancestor "$target" origin/main 2>/dev/null; then
  echo "current: the fork is built on $target, which the desktop runs."
  exit 0
fi
# A rerun after resolving a conflict finds the rebase done and resumes at the checks.
if ! git merge-base --is-ancestor "$target" HEAD 2>/dev/null; then
  git rev-parse -q --verify "refs/tags/$target" >/dev/null || { echo "refused: upstream has no tag $target." >&2; exit 1; }
  [ -z "$(git status --porcelain)" ] || { echo "refused: the working tree has changes." >&2; exit 1; }
  git branch -f "hq-before-$version" HEAD
  # Upstream tags releases on main, so only the fork's own commits are replayed.
  git rebase "$target"
fi
pnpm install --frozen-lockfile
pnpm --dir apps/web exec vp test run --project unit src/hqRooms.test.ts
pnpm --dir apps/web exec tsc --noEmit -p .
# Build to a scratch directory: the running :5799 server serves apps/web/dist.
out=$(mktemp -d)
T3CODE_PORT="${T3CODE_PORT:-3773}" T3CODE_SINGLE_ORIGIN_DEV=1 APP_VERSION="$version" pnpm --dir apps/web exec vp build --outDir "$out" --emptyOutDir
rm -rf "$out"
git checkout -q pnpm-lock.yaml
git push -q --force-with-lease origin HEAD:main
echo "rebased: the fork now builds on $target. Restart the :5799 server (see RESUME.md) to serve it."
