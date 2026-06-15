#!/usr/bin/env sh
set -eu

cleanup() {
  if [ -n "${NOVNC_SUPERVISOR_PID:-}" ]; then
    kill "$NOVNC_SUPERVISOR_PID" 2>/dev/null || true
  fi
  if [ -n "${VNC_SUPERVISOR_PID:-}" ]; then
    kill "$VNC_SUPERVISOR_PID" 2>/dev/null || true
  fi
  if [ -n "${XHS_PID:-}" ]; then
    kill "$XHS_PID" 2>/dev/null || true
  fi
  if [ -n "${DASHBOARD_PID:-}" ]; then
    kill "$DASHBOARD_PID" 2>/dev/null || true
  fi
  if [ -n "${XHS_MONITOR_PID:-}" ]; then
    kill "$XHS_MONITOR_PID" 2>/dev/null || true
  fi
  if [ -n "${XVFB_PID:-}" ]; then
    kill "$XVFB_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

start_vnc_supervisor() {
  (
    set +e
    child=""
    trap 'if [ -n "$child" ]; then kill "$child" 2>/dev/null || true; fi; exit 0' INT TERM
    while :; do
      x11vnc \
        -display "$DISPLAY" \
        -forever \
        -shared \
        -nopw \
        -localhost \
        -listen 127.0.0.1 \
        -rfbport "${XHS_VNC_PORT:-5900}" \
        -quiet &
      child="$!"
      wait "$child"
      code="$?"
      child=""
      echo "x11vnc exited with code ${code}; restarting in 1s" >&2
      sleep 1
    done
  ) &
  VNC_SUPERVISOR_PID="$!"
}

start_novnc_supervisor() {
  (
    set +e
    child=""
    trap 'if [ -n "$child" ]; then kill "$child" 2>/dev/null || true; fi; exit 0' INT TERM
    while :; do
      websockify \
        --web=/usr/share/novnc \
        "127.0.0.1:${XHS_NOVNC_PORT:-6080}" \
        "127.0.0.1:${XHS_VNC_PORT:-5900}" &
      child="$!"
      wait "$child"
      code="$?"
      child=""
      echo "websockify exited with code ${code}; restarting in 1s" >&2
      sleep 1
    done
  ) &
  NOVNC_SUPERVISOR_PID="$!"
}

CHROME_USER="${XHS_CHROME_USER:-kato}"
PROFILE_DIR="${XHS_PROFILE_DIR:-/app/mcp/xiaohongshu/data/profile}"
mkdir -p /app/data /app/output /app/mcp/xiaohongshu/data /app/mcp/xiaohongshu/images "$PROFILE_DIR"
if id "$CHROME_USER" >/dev/null 2>&1; then
  chown -R "$CHROME_USER:$CHROME_USER" /app/mcp/xiaohongshu/data /app/mcp/xiaohongshu/images "$PROFILE_DIR" /home/"$CHROME_USER" 2>/dev/null || true
fi

export DISPLAY="${XHS_DISPLAY:-:99}"
DISPLAY_SIZE="${XHS_DISPLAY_SIZE:-1440x980x24}"
Xvfb "$DISPLAY" -screen 0 "$DISPLAY_SIZE" -ac +extension RANDR &
XVFB_PID="$!"
sleep 0.5

if [ "${XHS_VNC_ENABLED:-1}" = "1" ]; then
  start_vnc_supervisor
  start_novnc_supervisor
fi

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
if [ -n "${VNC_SUPERVISOR_PID:-}" ]; then
  wait "$VNC_SUPERVISOR_PID" 2>/dev/null || true
fi
if [ -n "${NOVNC_SUPERVISOR_PID:-}" ]; then
  wait "$NOVNC_SUPERVISOR_PID" 2>/dev/null || true
fi
wait "$XVFB_PID" 2>/dev/null || true
exit "$STATUS"
