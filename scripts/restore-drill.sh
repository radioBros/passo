#!/usr/bin/env bash
# PASSO restore drill (DEP-020).
#
# An untested backup has never been shown to work. This restores into a SEPARATE
# database and verifies the result, so the drill is safe to run against a live
# instance — it never touches the running database.
#
#   ./scripts/restore-drill.sh backups/passo-20260902T120000Z.dump
set -euo pipefail

DUMP="${1:?usage: restore-drill.sh <dump-file>}"
: "${POSTGRES_USER:=passo_admin}"
: "${POSTGRES_DB:=passo}"
TARGET="passo_restore_drill"

echo "→ restoring into $TARGET (the live database is untouched)"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS $TARGET;" > /dev/null
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres \
  -c "CREATE DATABASE $TARGET;" > /dev/null
docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$TARGET" --no-owner < "$DUMP"

q() { docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$1" -tAc "$2" | tr -d ' '; }

echo "→ comparing row counts"
for t in sdi_submissions invoices audit_log correlation_records notifications; do
  LIVE=$(q "$POSTGRES_DB" "SELECT count(*) FROM $t")
  REST=$(q "$TARGET" "SELECT count(*) FROM $t")
  printf '   %-22s live=%-8s restored=%-8s' "$t" "$LIVE" "$REST"
  [ "$LIVE" = "$REST" ] && echo "OK" || { echo "MISMATCH"; FAILED=1; }
done

# The chain is the reason this drill exists: a restore that silently reorders
# or drops audit rows would destroy the tamper evidence exactly when it matters.
echo "→ verifying the audit chain survived"
CHAIN_SQL="WITH q AS (SELECT tenant_id, prev_hash, lag(hash) OVER (PARTITION BY tenant_id ORDER BY id) AS lag_hash FROM audit_log) SELECT count(DISTINCT tenant_id) FROM q WHERE lag_hash IS NOT NULL AND prev_hash IS DISTINCT FROM lag_hash"
LIVE_BROKEN=$(q "$POSTGRES_DB" "$CHAIN_SQL")
REST_BROKEN=$(q "$TARGET" "$CHAIN_SQL")
printf '   broken chains          live=%-8s restored=%-8s' "$LIVE_BROKEN" "$REST_BROKEN"
if [ "$LIVE_BROKEN" = "$REST_BROKEN" ]; then
  echo "OK (the restore introduced none)"
else
  echo "MISMATCH — the restore altered the audit chain"; FAILED=1
fi

docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE $TARGET;" > /dev/null
echo "→ drill database dropped"

if [ "${FAILED:-0}" = "1" ]; then echo; echo "DRILL FAILED"; exit 1; fi
echo; echo "DRILL PASSED"
