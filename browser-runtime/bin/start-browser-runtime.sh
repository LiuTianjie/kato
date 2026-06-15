#!/usr/bin/env sh
set -eu

export DISPLAY="${BROWSER_DISPLAY:-${XHS_DISPLAY:-:99}}"

exec node /app/browser-runtime/service/server.js
