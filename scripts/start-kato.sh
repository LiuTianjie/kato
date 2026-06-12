#!/usr/bin/env sh
set -eu

cleanup() {
  if [ -n "${XHS_PID:-}" ]; then
    kill "$XHS_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

PORT="${XHS_SERVICE_PORT:-18060}" node mcp/xiaohongshu/service/server.js &
XHS_PID="$!"

PORT="${PORT:-4173}" node dist/dashboard/server.js
