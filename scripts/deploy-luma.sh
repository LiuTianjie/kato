#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${MANIFEST:-$ROOT_DIR/deploy/kato.luma.yml}"
XHS_API_TOKEN_VALUE="${XHS_API_TOKEN_VALUE:-LiuTao0.1}"
ARK_API_KEY_VALUE="${ARK_API_KEY_VALUE:-${ARK_API_KEY:-}}"
ARK_MODEL_VALUE="${ARK_MODEL_VALUE:-${ARK_MODEL:-}}"
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-1800}"

if ! command -v luma >/dev/null 2>&1; then
  echo "luma CLI not found. Install luma-infra first." >&2
  exit 1
fi

has_luma_secret() {
  local name="$1"
  luma secret list | awk '{print $1}' | grep -qx "$name"
}

set_or_require_secret() {
  local name="$1"
  local value="$2"

  if [[ -n "$value" ]]; then
    luma secret set "$name" --value "$value"
    return
  fi

  if has_luma_secret "$name"; then
    echo "Using existing Luma secret: $name"
    return
  fi

  echo "$name is required. Export ${name}_VALUE before deploy, or set it with: luma secret set $name --value '...'" >&2
  exit 1
}

luma secret set XHS_API_TOKEN --value "$XHS_API_TOKEN_VALUE"
set_or_require_secret ARK_API_KEY "$ARK_API_KEY_VALUE"
set_or_require_secret ARK_MODEL "$ARK_MODEL_VALUE"

luma validate "$MANIFEST"
luma deploy "$MANIFEST" --dry-run

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1, skipped live deploy."
  exit 0
fi

luma deploy "$MANIFEST" --format ndjson --timeout "$DEPLOY_TIMEOUT"
