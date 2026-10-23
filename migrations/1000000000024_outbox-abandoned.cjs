/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Distinguish ABANDONED from PUBLISHED (outbox relay).
 *
 * A row the broker repeatedly refuses used to be stamped `published_at` so it
 * would stop blocking the queue. That is a lie with consequences: the purge
 * worker deletes by `published_at`, so an invoice that never reached RabbitMQ
 * was quietly destroyed after the retention window, leaving only a log line.
 *
 * `abandoned_at` keeps such a row out of the relay's way while preserving it,
 * and makes "how many invoices did we fail to publish" an answerable question:
 *
 *   SELECT count(*) FROM outbox WHERE abandoned_at IS NOT NULL;
 */
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE outbox ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMPTZ;');
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS outbox_abandoned_idx
      ON outbox (abandoned_at) WHERE abandoned_at IS NOT NULL;
  `);

  /**
   * Recover rows a previous release mis-stamped.
   *
   * `attempts >= 20` with a `published_at` is the signature of the old
   * abandon path — a genuinely published row is stamped on its FIRST
   * successful attempt, so a high attempt count plus a publish timestamp can
   * only mean it was abandoned rather than sent.
   */
  pgm.sql(`
    UPDATE outbox
       SET abandoned_at = published_at, published_at = NULL
     WHERE published_at IS NOT NULL AND attempts >= 20;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS outbox_abandoned_idx;');
  pgm.sql('ALTER TABLE outbox DROP COLUMN IF EXISTS abandoned_at;');
};
