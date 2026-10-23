/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Let the purge role bound the operational tables.
 *
 * `outbox`, `webhook_deliveries`, `idempotency_keys` and resolved quarantine
 * rows hold no fiscal record, so nothing in the retention story forced them to
 * be bounded — and they grew without limit. The outbox and the delivery log are
 * the fastest-growing tables in the system: one row per job, one per webhook
 * attempt, kept forever.
 *
 * The grants are DELETE only, and the purge worker's own predicates are what
 * keep them safe: a pending outbox row is an invoice not yet published, and an
 * unresolved quarantined receipt is a legal document whose owner is still
 * unknown. Neither is ever eligible on age alone.
 */
exports.up = (pgm) => {
  pgm.sql(`
    GRANT SELECT, DELETE ON outbox                    TO passo_purge;
    GRANT SELECT, DELETE ON webhook_deliveries        TO passo_purge;
    GRANT SELECT, DELETE ON idempotency_keys          TO passo_purge;
    GRANT SELECT, DELETE ON quarantined_notifications TO passo_purge;
  `);

  // Partial indexes matching the purge predicates: without them each sweep is a
  // sequential scan over the largest tables in the database, every hour.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS outbox_published_idx
      ON outbox (published_at) WHERE published_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS webhook_deliveries_delivered_idx
      ON webhook_deliveries (created_at) WHERE delivered_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx
      ON idempotency_keys (created_at);
    CREATE INDEX IF NOT EXISTS quarantined_resolved_idx
      ON quarantined_notifications (resolved_at) WHERE resolved_at IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS outbox_published_idx;
    DROP INDEX IF EXISTS webhook_deliveries_delivered_idx;
    DROP INDEX IF EXISTS idempotency_keys_created_idx;
    DROP INDEX IF EXISTS quarantined_resolved_idx;
  `);
  pgm.sql(`
    REVOKE DELETE ON outbox, webhook_deliveries, idempotency_keys,
                     quarantined_notifications FROM passo_purge;
  `);
};
