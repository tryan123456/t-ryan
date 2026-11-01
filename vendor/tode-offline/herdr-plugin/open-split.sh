#!/usr/bin/env bash
set -euo pipefail

if ! command -v tode >/dev/null 2>&1; then
  echo "tode is not installed — see https://github.com/zenbu-labs/tode" >&2
  exit 1
fi

exec tode --split right
