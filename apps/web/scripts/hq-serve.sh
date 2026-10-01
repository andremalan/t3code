#!/bin/sh
# HQ fork: production build served single-origin. The preview server inherits the
# dev proxy, so /api, /ws, /oauth, /.well-known reach the desktop T3 server and /hq reaches HQ (:3939).
set -e
cd "$(dirname "$0")/.."
# The desktop app takes the next free port when 3773 is busy; its runtime file records the one it got.
desktop=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$HOME/.t3/userdata/server-runtime.json" 2>/dev/null)
export T3CODE_PORT="${T3CODE_PORT:-${desktop:-3773}}" T3CODE_SINGLE_ORIGIN_DEV=1
# Release tags do not bump package.json; the tag is the version the client reports.
export APP_VERSION="${APP_VERSION:-$(git describe --tags --abbrev=0 --exclude '*-*' | sed 's/^v//')}"
vp build
exec vp preview --host 127.0.0.1 --port "${PORT:-5799}" --strictPort
