#!/usr/bin/env bash
# Logical backup of the OpenWork Postgres database (custom format for pg_restore).
# Requires pg_dump on PATH and DATABASE_URL (same as backend SQL mode).
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to the database to dump (e.g. postgres://user:pass@host:5432/db)}"

BACKEND_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS="${BACKEND_ROOT}/migration-artifacts"
mkdir -p "$ARTIFACTS"
STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
OUT="${ARTIFACTS}/postgres-custom-${STAMP}.dump"

pg_dump "$DATABASE_URL" -Fc --no-owner -f "$OUT"
echo "Wrote ${OUT}"
