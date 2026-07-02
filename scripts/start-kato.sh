#!/usr/bin/env bash
set -euo pipefail

PIDS=()
NAMES=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}

trap cleanup INT TERM EXIT

CHROME_USER="${BROWSER_CHROME_USER:-${XHS_CHROME_USER:-kato}}"
BROWSER_BIN_DEFAULT="${BROWSER_BIN:-/usr/local/bin/kato-chromium}"

export TZ="${TZ:-Asia/Shanghai}"
export BROWSER_TIMEZONE_ID="${BROWSER_TIMEZONE_ID:-Asia/Shanghai}"
export XHS_TIMEZONE_ID="${XHS_TIMEZONE_ID:-${BROWSER_TIMEZONE_ID}}"

XHS_VIEWER_RUNTIME_PORT="${XHS_VIEWER_RUNTIME_PORT:-18100}"
XHS_WORKER_RUNTIME_PORT="${XHS_WORKER_RUNTIME_PORT:-${BROWSER_RUNTIME_PORT:-18101}}"
DOUYIN_VIEWER_RUNTIME_PORT="${DOUYIN_VIEWER_RUNTIME_PORT:-18110}"
DOUYIN_WORKER_RUNTIME_PORT="${DOUYIN_WORKER_RUNTIME_PORT:-18111}"
BILIBILI_VIEWER_RUNTIME_PORT="${BILIBILI_VIEWER_RUNTIME_PORT:-18120}"
BILIBILI_WORKER_RUNTIME_PORT="${BILIBILI_WORKER_RUNTIME_PORT:-18121}"

export BROWSER_VIEWER_RUNTIME_URL="${BROWSER_VIEWER_RUNTIME_URL:-http://127.0.0.1:${XHS_VIEWER_RUNTIME_PORT}}"
export BROWSER_WORKER_RUNTIME_URL="${BROWSER_WORKER_RUNTIME_URL:-http://127.0.0.1:${XHS_WORKER_RUNTIME_PORT}}"
export XHS_VIEWER_RUNTIME_URL="${XHS_VIEWER_RUNTIME_URL:-http://127.0.0.1:${XHS_VIEWER_RUNTIME_PORT}}"
export XHS_BROWSER_RUNTIME_URL="${XHS_BROWSER_RUNTIME_URL:-http://127.0.0.1:${XHS_WORKER_RUNTIME_PORT}}"
export DOUYIN_VIEWER_RUNTIME_URL="${DOUYIN_VIEWER_RUNTIME_URL:-http://127.0.0.1:${DOUYIN_VIEWER_RUNTIME_PORT}}"
export DOUYIN_BROWSER_RUNTIME_URL="${DOUYIN_BROWSER_RUNTIME_URL:-http://127.0.0.1:${DOUYIN_WORKER_RUNTIME_PORT}}"
export BILIBILI_VIEWER_RUNTIME_URL="${BILIBILI_VIEWER_RUNTIME_URL:-http://127.0.0.1:${BILIBILI_VIEWER_RUNTIME_PORT}}"
export BILIBILI_BROWSER_RUNTIME_URL="${BILIBILI_BROWSER_RUNTIME_URL:-http://127.0.0.1:${BILIBILI_WORKER_RUNTIME_PORT}}"

export XHS_INTERNAL_CDP_PORT="${XHS_INTERNAL_CDP_PORT:-9225}"
export XHS_CDP_PORT="${XHS_CDP_PORT:-${XHS_INTERNAL_CDP_PORT}}"
export DOUYIN_INTERNAL_CDP_PORT="${DOUYIN_INTERNAL_CDP_PORT:-9235}"
export BILIBILI_INTERNAL_CDP_PORT="${BILIBILI_INTERNAL_CDP_PORT:-9245}"
export BROWSER_RUNTIME_URL="${BROWSER_RUNTIME_URL:-${XHS_BROWSER_RUNTIME_URL}}"
export BROWSER_RUNTIME_PORT="${BROWSER_RUNTIME_PORT:-${XHS_WORKER_RUNTIME_PORT}}"
export BROWSER_CDP_PORT="${BROWSER_CDP_PORT:-${XHS_INTERNAL_CDP_PORT}}"

export XHS_PROFILE_DIR="${XHS_PROFILE_DIR:-/app/data/platforms/xhs/worker-profile}"
export XHS_STORAGE_PATH="${XHS_STORAGE_PATH:-/app/data/platforms/xhs/storage.json}"
export DOUYIN_PROFILE_DIR="${DOUYIN_PROFILE_DIR:-/app/data/platforms/douyin/worker-profile}"
export BILIBILI_PROFILE_DIR="${BILIBILI_PROFILE_DIR:-/app/data/platforms/bilibili/worker-profile}"
export COOKIES_PATH="${COOKIES_PATH:-/app/mcp/xiaohongshu/data/cookies.json}"
export DOUYIN_COOKIES_PATH="${DOUYIN_COOKIES_PATH:-/app/data/platforms/douyin/cookies.json}"
export BILIBILI_COOKIES_PATH="${BILIBILI_COOKIES_PATH:-/app/data/platforms/bilibili/cookies.json}"
export DOUYIN_SERVICE_URL="${DOUYIN_SERVICE_URL:-http://127.0.0.1:${DOUYIN_SERVICE_PORT:-18070}}"
export BILIBILI_SERVICE_URL="${BILIBILI_SERVICE_URL:-http://127.0.0.1:${BILIBILI_SERVICE_PORT:-18080}}"

mkdir -p \
  /app/data /app/output \
  /app/data/browser-runtimes \
  /app/data/platforms/xhs /app/data/platforms/douyin /app/data/platforms/bilibili \
  /app/mcp/xiaohongshu/data /app/mcp/xiaohongshu/images

if [[ "${KATO_FIX_OWNERSHIP:-0}" == "1" ]] && id "$CHROME_USER" >/dev/null 2>&1; then
  chown -R "$CHROME_USER:$CHROME_USER" /app/data /app/mcp/xiaohongshu/data /app/mcp/xiaohongshu/images /home/"$CHROME_USER" 2>/dev/null || true
fi

start_process() {
  local name="$1"
  shift
  "$@" &
  local pid="$!"
  PIDS+=("$pid")
  NAMES+=("$name")
  echo "Started ${name} pid=${pid}" >&2
}

start_runtime() {
  local platform="$1"
  local kind="$2"
  local port="$3"
  local display="$4"
  local cdp_port="$5"
  local vnc_enabled="$6"
  local vnc_port="$7"
  local novnc_port="$8"
  local profile_dir="$9"
  local cookies_path="${10}"
  local mirror_paths="${11:-}"

  mkdir -p "$profile_dir" "$(dirname "$cookies_path")"
  if [[ "${KATO_FIX_OWNERSHIP:-0}" == "1" ]] && id "$CHROME_USER" >/dev/null 2>&1; then
    chown -R "$CHROME_USER:$CHROME_USER" "$profile_dir" "$(dirname "$cookies_path")" 2>/dev/null || true
  fi

  start_process "${platform}-${kind}-runtime" env \
    BROWSER_RUNTIME_NAME="${platform}-${kind}" \
    BROWSER_RUNTIME_PORT="$port" \
    BROWSER_DISPLAY="$display" \
    BROWSER_CDP_PORT="$cdp_port" \
    BROWSER_VNC_ENABLED="$vnc_enabled" \
    BROWSER_VNC_PORT="$vnc_port" \
    BROWSER_NOVNC_PORT="$novnc_port" \
    BROWSER_PROFILE_DIR="$profile_dir" \
    BROWSER_COOKIES_PATH="$cookies_path" \
    BROWSER_COOKIE_MIRROR_PATHS="$mirror_paths" \
    BROWSER_BIN="$BROWSER_BIN_DEFAULT" \
    BROWSER_CHROME_USER="$CHROME_USER" \
    TZ="${TZ:-Asia/Shanghai}" \
    BROWSER_TIMEZONE_ID="${BROWSER_TIMEZONE_ID:-Asia/Shanghai}" \
    XHS_TIMEZONE_ID="${XHS_TIMEZONE_ID:-${BROWSER_TIMEZONE_ID:-Asia/Shanghai}}" \
    LANG="${LANG:-zh_CN.UTF-8}" \
    LC_ALL="${LC_ALL:-zh_CN.UTF-8}" \
    LANGUAGE="${LANGUAGE:-zh_CN:zh}" \
    node browser-runtime/service/server.js
}

start_runtime xhs viewer "$XHS_VIEWER_RUNTIME_PORT" "${XHS_VIEWER_DISPLAY:-:99}" "${XHS_VIEWER_CDP_PORT:-9224}" 1 "${XHS_VIEWER_VNC_PORT:-5900}" "${XHS_VIEWER_NOVNC_PORT:-6080}" "${XHS_VIEWER_PROFILE_DIR:-/app/data/browser-runtimes/xhs-viewer/profile}" "${XHS_VIEWER_COOKIES_PATH:-/app/data/browser-runtimes/xhs-viewer/cookies.json}" ""
start_runtime xhs worker "$XHS_WORKER_RUNTIME_PORT" "${XHS_WORKER_DISPLAY:-:100}" "$XHS_INTERNAL_CDP_PORT" "${XHS_WORKER_VNC_ENABLED:-1}" "${XHS_WORKER_VNC_PORT:-5901}" "${XHS_WORKER_NOVNC_PORT:-6081}" "$XHS_PROFILE_DIR" "$COOKIES_PATH" ""
start_runtime douyin viewer "$DOUYIN_VIEWER_RUNTIME_PORT" "${DOUYIN_VIEWER_DISPLAY:-:101}" "${DOUYIN_VIEWER_CDP_PORT:-9234}" 1 "${DOUYIN_VIEWER_VNC_PORT:-5910}" "${DOUYIN_VIEWER_NOVNC_PORT:-6090}" "${DOUYIN_VIEWER_PROFILE_DIR:-/app/data/browser-runtimes/douyin-viewer/profile}" "${DOUYIN_VIEWER_COOKIES_PATH:-/app/data/browser-runtimes/douyin-viewer/cookies.json}" ""
start_runtime douyin worker "$DOUYIN_WORKER_RUNTIME_PORT" "${DOUYIN_WORKER_DISPLAY:-:102}" "$DOUYIN_INTERNAL_CDP_PORT" "${DOUYIN_WORKER_VNC_ENABLED:-1}" "${DOUYIN_WORKER_VNC_PORT:-5911}" "${DOUYIN_WORKER_NOVNC_PORT:-6091}" "$DOUYIN_PROFILE_DIR" "$DOUYIN_COOKIES_PATH" ""
start_runtime bilibili viewer "$BILIBILI_VIEWER_RUNTIME_PORT" "${BILIBILI_VIEWER_DISPLAY:-:103}" "${BILIBILI_VIEWER_CDP_PORT:-9244}" 1 "${BILIBILI_VIEWER_VNC_PORT:-5920}" "${BILIBILI_VIEWER_NOVNC_PORT:-6100}" "${BILIBILI_VIEWER_PROFILE_DIR:-/app/data/browser-runtimes/bilibili-viewer/profile}" "${BILIBILI_VIEWER_COOKIES_PATH:-/app/data/browser-runtimes/bilibili-viewer/cookies.json}" ""
start_runtime bilibili worker "$BILIBILI_WORKER_RUNTIME_PORT" "${BILIBILI_WORKER_DISPLAY:-:104}" "$BILIBILI_INTERNAL_CDP_PORT" "${BILIBILI_WORKER_VNC_ENABLED:-1}" "${BILIBILI_WORKER_VNC_PORT:-5921}" "${BILIBILI_WORKER_NOVNC_PORT:-6101}" "$BILIBILI_PROFILE_DIR" "$BILIBILI_COOKIES_PATH" ""

start_process xhs-service env PORT="${XHS_SERVICE_PORT:-18060}" node mcp/xiaohongshu/service/server.js
start_process douyin-service env PORT="${DOUYIN_SERVICE_PORT:-18070}" node mcp/douyin/service/server.js
start_process bilibili-service env PORT="${BILIBILI_SERVICE_PORT:-18080}" node mcp/bilibili/service/server.js
if [[ "${KATO_DEV_HOT_RELOAD:-0}" == "1" ]]; then
  start_process dashboard env PORT="${PORT:-4173}" ./node_modules/.bin/tsx src/dashboard/server.ts
else
  start_process dashboard env PORT="${PORT:-4173}" node dist/dashboard/server.js
fi

set +e
wait -n "${PIDS[@]}"
STATUS="$?"
set -e

for index in "${!PIDS[@]}"; do
  if ! kill -0 "${PIDS[$index]}" 2>/dev/null; then
    echo "${NAMES[$index]} exited with code ${STATUS}; stopping Kato services" >&2
    break
  fi
done

cleanup
for pid in "${PIDS[@]}"; do
  wait "$pid" 2>/dev/null || true
done
exit "$STATUS"
