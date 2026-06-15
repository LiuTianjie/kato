#!/usr/bin/env bash
set -euo pipefail

DISPLAY_SIZE="${XHS_DISPLAY_SIZE:-1440x980x24}"
CHROME_USER="${XHS_CHROME_USER:-kato}"
CHROME_BIN="/usr/bin/google-chrome-stable"

run_chrome() {
  if [ "$(id -u)" = "0" ] && [ -n "$CHROME_USER" ] && id "$CHROME_USER" >/dev/null 2>&1; then
    exec runuser -u "$CHROME_USER" -- "$CHROME_BIN" "$@"
  fi
  exec "$CHROME_BIN" "$@"
}

if [ -n "${DISPLAY:-}" ]; then
  run_chrome "$@"
fi

exec xvfb-run \
  --auto-servernum \
  --server-args="-screen 0 ${DISPLAY_SIZE} -ac +extension RANDR" \
  "$0" "$@"
