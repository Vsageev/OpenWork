#!/usr/bin/env bash
# Restore a custom-format pg_dump into an empty or disposable database.
# Typical verification: create a second DB on the same server, then restore.
#
# Example:
#   createdb -h localhost -U openwork openwork_restore
#   DATABASE_URL=postgres://openwork:openwork@localhost:5432/openwork_restore pnpm --filter backend db:migrate
#   TARGET_DATABASE_URL=postgres://openwork:openwork@localhost:5432/openwork_restore \
#     bash packages/backend/scripts/migration-sql-restore.sh packages/backend/migration-artifacts/postgres-custom-....dump
#
# Or restore without pre-migrate if the archive includes schema (full pg_dump default):
#   TARGET_DATABASE_URL=postgres://.../openwork_restore bash .../migration-sql-restore.sh my.dump
set -euo pipefail

DUMP="${1:?Usage: $0 <path-to-custom-format-dump>}"
: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL to the empty/disposable database URL}"

if [[ ! -f "$DUMP" ]]; then
  echo "Dump file not found: $DUMP" >&2
  exit 1
fi

pg_restore -d "$TARGET_DATABASE_URL" --clean --if-exists --no-owner "$DUMP"
echo "Restored into ${TARGET_DATABASE_URL}"
