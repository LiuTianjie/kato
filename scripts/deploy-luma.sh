#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${MANIFEST:-$ROOT_DIR/deploy/kato.luma.yml}"
XHS_API_TOKEN_VALUE="${XHS_API_TOKEN_VALUE:-LiuTao0.1}"
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-1800}"

if ! command -v luma >/dev/null 2>&1; then
  echo "luma CLI not found. Install luma-infra first." >&2
  exit 1
fi

luma secret set XHS_API_TOKEN --value "$XHS_API_TOKEN_VALUE"

luma validate "$MANIFEST"
luma deploy "$MANIFEST" --dry-run

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1, skipped live deploy."
  exit 0
fi

luma deploy "$MANIFEST" --format ndjson --timeout "$DEPLOY_TIMEOUT"
