#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${DATA_DIR:-/data}/netdisk-users" "${OUTPUT_DIR:-/outputs}" "${CACHE_DIR:-/cache}/downloads" "${CACHE_DIR:-/cache}/audio"
chown -R node:node "${DATA_DIR:-/data}" "${OUTPUT_DIR:-/outputs}" "${CACHE_DIR:-/cache}"

if [[ -n "${CHROME_PATH:-}" && ! -x "${CHROME_PATH}" ]]; then
  unset CHROME_PATH
fi

if [[ -n "${CHROMIUM_PATH:-}" && ! -x "${CHROMIUM_PATH}" ]]; then
  unset CHROMIUM_PATH
fi

if [[ "${1:-}" == "node" || "${1:-}" == "npm" || "${1:-}" == "bash" || "${1:-}" == "sh" ]]; then
  exec gosu node "$@"
fi

exec "$@"
