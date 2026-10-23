/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * A narrow, cross-tenant view of what is still waiting on SdI (NOTIF-023).
 *
 * Stall detection asks a question no single tenant context can answer — "is
 * anything stuck anywhere" — so it must read across tenants. Rather than grant
 * `passo_relay` the whole `sdi_submissions` table, this view exposes ONLY
 * channel, state and timing: no invoice content, no counterparty, no tenant
 * identity, not even a submission id. That narrowness is what makes the
 * RLS-exempt read acceptable, exactly as with `correlation_routing`.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW submission_wait_status AS
      SELECT channel, state, submitted_at
        FROM sdi_submissions
       WHERE state IN ('transmitted', 'awaiting_delivery');
  `);
  pgm.sql('GRANT SELECT ON submission_wait_status TO passo_relay;');
};

exports.down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS submission_wait_status;');
};
