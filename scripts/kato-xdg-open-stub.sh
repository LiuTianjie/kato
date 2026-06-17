#!/usr/bin/env bash
set -euo pipefail

# Containers do not have useful desktop protocol handlers. Pretend success so
# Chrome does not spawn fallback browsers when a page asks to open an app link.
exit 0
