#!/usr/bin/env bash
# PASSO backup (DEP-019).
#
# Postgres is the ONLY thing that must be backed up. RabbitMQ and Redis are
# reconstructible: the outbox replays anything the broker lost, and Redis holds
# only rate-limit counters and sync-mode pub/sub.
#
#   ./scripts/backup.sh [output-dir]
#
# The dump contains ENCRYPTED invoice payloads. It does NOT contain the
# encryption keys — those live in the environment. A backup without them is
# unreadable, which is deliberate: back the keys up separately, and never in the
# same place, or the encryption at rest protects nothing.
set -euo pipefail

OUT="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT/passo-$STAMP.dump"
mkdir -p "$OUT"

: "${POSTGRES_USER:=passo_admin}"
: "${POSTGRES_DB:=passo}"

echo "→ dumping $POSTGRES_DB"
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$FILE"

# A dump that cannot be read back is not a backup. Listing the archive forces
# the format to be parsed, catching a truncated or corrupt file now rather than
# during an incident.
echo "→ verifying the archive is readable"
docker compose exec -T postgres pg_restore -l < "$FILE" > /dev/null

SIZE=$(du -h "$FILE" | cut -f1)
echo "→ $FILE ($SIZE)"
echo
echo "REMINDER: back up PASSO_ENCRYPTION_KEY_* separately, and NOT alongside"
echo "this file. The dump holds ciphertext; without the keys it is unreadable."
