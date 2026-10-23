/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Channel health, for stalled-submission detection (NOTIF-023).
 *
 * A submission that reaches SdI and never hears back produces no error: nothing
 * throws, no retry fires, no queue grows. Detecting it needs a signal that
 * exists even when nothing is in flight — otherwise a poller that dies during a
 * quiet hour is invisible until invoices pile up behind it.
 *
 * `last_poll_at` is that signal. It is NOT tenant-scoped: a poller serves every
 * tenant on its channel, and "did the PEC poller run" is a question about the
 * process, not about any one tenant's data. The table holds no invoice content —
 * only a channel name and timestamps.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS channel_health (
      channel        TEXT PRIMARY KEY,
      poll_based     BOOLEAN     NOT NULL DEFAULT false,
      last_poll_at   TIMESTAMPTZ,
      last_error     TEXT,
      last_error_at  TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // PEC is the only channel PASSO must poll; the vendors push webhooks to us.
  pgm.sql(`
    INSERT INTO channel_health (channel, poll_based) VALUES
      ('pec', true), ('invoicetronic', false), ('openapi', false), ('mock', false)
    ON CONFLICT (channel) DO NOTHING;
  `);

  // Written by the poller (as passo_relay), read by the stall detector.
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON channel_health TO passo_relay;');

  /**
   * `submitted_at` records when a submission actually reached SdI. Age is
   * measured from that instant, not from row creation: a job that sat in the
   * queue was never waiting on SdI, and counting that time would report a
   * backlog of our own making as SdI being slow.
   */
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS sdi_submissions_awaiting_idx
      ON sdi_submissions (channel, submitted_at)
      WHERE state IN ('transmitted', 'awaiting_delivery');
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS sdi_submissions_awaiting_idx;');
  pgm.sql('DROP TABLE IF EXISTS channel_health;');
};
