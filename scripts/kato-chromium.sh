#!/usr/bin/env bash
set -euo pipefail

DISPLAY_SIZE="${XHS_DISPLAY_SIZE:-1440x980x24}"

if [ -n "${DISPLAY:-}" ]; then
  exec /usr/bin/google-chrome-stable "$@"
fi

exec xvfb-run \
  --auto-servernum \
  --server-args="-screen 0 ${DISPLAY_SIZE} -ac +extension RANDR" \
  /usr/bin/google-chrome-stable "$@"
