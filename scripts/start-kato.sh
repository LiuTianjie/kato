#!/usr/bin/env sh
set -eu

cleanup() {
  if [ -n "${XHS_PID:-}" ]; then
    kill "$XHS_PID" 2>/dev/null || true
  fi
  if [ -n "${DASHBOARD_PID:-}" ]; then
    kill "$DASHBOARD_PID" 2>/dev/null || true
  fi
  if [ -n "${XHS_MONITOR_PID:-}" ]; then
    kill "$XHS_MONITOR_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

PORT="${XHS_SERVICE_PORT:-18060}" node mcp/xiaohongshu/service/server.js &
XHS_PID="$!"

PORT="${PORT:-4173}" node dist/dashboard/server.js &
DASHBOARD_PID="$!"

(
  wait "$XHS_PID"
  code="$?"
  echo "XHS browser service exited with code ${code}; stopping dashboard" >&2
  kill "$DASHBOARD_PID" 2>/dev/null || true
  exit "$code"
) &
XHS_MONITOR_PID="$!"

wait "$DASHBOARD_PID"
STATUS="$?"
cleanup
wait "$XHS_PID" 2>/dev/null || true
wait "$XHS_MONITOR_PID" 2>/dev/null || true
exit "$STATUS"
