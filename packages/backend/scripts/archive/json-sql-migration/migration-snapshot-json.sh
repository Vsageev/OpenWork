#!/usr/bin/env bash
# Pre-cutover snapshot of JSON collections under DATA_DIR into migration-artifacts/.
# Safe to run while the service uses JSON mode; does not delete source data.
set -euo pipefail

BACKEND_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-./data}"

if [[ "${DATA_DIR}" == /* ]]; then
  DATA_PATH="$DATA_DIR"
else
  DATA_PATH="${BACKEND_ROOT}/${DATA_DIR}"
fi

if [[ ! -d "$DATA_PATH" ]]; then
  echo "DATA_DIR does not exist or is not a directory: $DATA_PATH" >&2
  exit 1
fi

ARTIFACTS="${BACKEND_ROOT}/migration-artifacts"
mkdir -p "$ARTIFACTS"
STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
NAME="json-data-${STAMP}.tar.gz"
OUT="${ARTIFACTS}/${NAME}"

tar -czf "$OUT" -C "$(dirname "$DATA_PATH")" "$(basename "$DATA_PATH")"
echo "Wrote ${OUT}"
