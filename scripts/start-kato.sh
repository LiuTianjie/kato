#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  if [ -n "${XHS_PID:-}" ]; then
    kill "$XHS_PID" 2>/dev/null || true
  fi
  if [ -n "${DASHBOARD_PID:-}" ]; then
    kill "$DASHBOARD_PID" 2>/dev/null || true
  fi
  if [ -n "${RUNTIME_PID:-}" ]; then
    kill "$RUNTIME_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

export BROWSER_RUNTIME_PORT="${BROWSER_RUNTIME_PORT:-${XHS_BROWSER_RUNTIME_PORT:-18100}}"
export BROWSER_RUNTIME_URL="${BROWSER_RUNTIME_URL:-${XHS_BROWSER_RUNTIME_URL:-http://127.0.0.1:${BROWSER_RUNTIME_PORT}}}"
export XHS_BROWSER_RUNTIME_URL="${XHS_BROWSER_RUNTIME_URL:-${BROWSER_RUNTIME_URL}}"
export BROWSER_DISPLAY="${BROWSER_DISPLAY:-${XHS_DISPLAY:-:99}}"
export XHS_DISPLAY="${XHS_DISPLAY:-${BROWSER_DISPLAY}}"
export BROWSER_CDP_HOST="${BROWSER_CDP_HOST:-${XHS_CDP_HOST:-127.0.0.1}}"
export XHS_CDP_HOST="${XHS_CDP_HOST:-${BROWSER_CDP_HOST}}"
export BROWSER_CDP_PORT="${BROWSER_CDP_PORT:-${XHS_INTERNAL_CDP_PORT:-${XHS_CDP_PORT:-9224}}}"
export XHS_INTERNAL_CDP_PORT="${XHS_INTERNAL_CDP_PORT:-${BROWSER_CDP_PORT}}"
export XHS_CDP_PORT="${XHS_CDP_PORT:-${BROWSER_CDP_PORT}}"
export BROWSER_VNC_PORT="${BROWSER_VNC_PORT:-${XHS_VNC_PORT:-5900}}"
export XHS_VNC_PORT="${XHS_VNC_PORT:-${BROWSER_VNC_PORT}}"
export BROWSER_NOVNC_PORT="${BROWSER_NOVNC_PORT:-${XHS_NOVNC_PORT:-6080}}"
export XHS_NOVNC_PORT="${XHS_NOVNC_PORT:-${BROWSER_NOVNC_PORT}}"
export BROWSER_PROFILE_DIR="${BROWSER_PROFILE_DIR:-${XHS_PROFILE_DIR:-/app/mcp/xiaohongshu/data/profile}}"
export XHS_PROFILE_DIR="${XHS_PROFILE_DIR:-${BROWSER_PROFILE_DIR}}"
export BROWSER_COOKIES_PATH="${BROWSER_COOKIES_PATH:-${COOKIES_PATH:-/app/mcp/xiaohongshu/data/cookies.json}}"
export COOKIES_PATH="${COOKIES_PATH:-${BROWSER_COOKIES_PATH}}"
export BROWSER_COOKIE_MIRROR_PATHS="${BROWSER_COOKIE_MIRROR_PATHS:-/app/data/cookies.json}"

CHROME_USER="${BROWSER_CHROME_USER:-${XHS_CHROME_USER:-kato}}"
mkdir -p /app/data /app/output /app/mcp/xiaohongshu/data /app/mcp/xiaohongshu/images "$BROWSER_PROFILE_DIR"
if id "$CHROME_USER" >/dev/null 2>&1; then
  chown -R "$CHROME_USER:$CHROME_USER" /app/data /app/mcp/xiaohongshu/data /app/mcp/xiaohongshu/images "$BROWSER_PROFILE_DIR" /home/"$CHROME_USER" 2>/dev/null || true
fi

node browser-runtime/service/server.js &
RUNTIME_PID="$!"

PORT="${XHS_SERVICE_PORT:-18060}" node mcp/xiaohongshu/service/server.js &
XHS_PID="$!"

PORT="${PORT:-4173}" node dist/dashboard/server.js &
DASHBOARD_PID="$!"

set +e
wait -n "$RUNTIME_PID" "$XHS_PID" "$DASHBOARD_PID"
STATUS="$?"
set -e

if ! kill -0 "$RUNTIME_PID" 2>/dev/null; then
  echo "Browser runtime exited with code ${STATUS}; stopping Kato services" >&2
elif ! kill -0 "$XHS_PID" 2>/dev/null; then
  echo "XHS browser service exited with code ${STATUS}; stopping dashboard" >&2
elif ! kill -0 "$DASHBOARD_PID" 2>/dev/null; then
  echo "Dashboard exited with code ${STATUS}; stopping Kato services" >&2
fi

cleanup
wait "$XHS_PID" 2>/dev/null || true
wait "$RUNTIME_PID" 2>/dev/null || true
wait "$DASHBOARD_PID" 2>/dev/null || true
exit "$STATUS"
