/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Tenant enumeration for the PEC poller.
 *
 * The poller must ask "which tenants have an active PEC channel?" BEFORE it can
 * know a tenant — the answer is the list it iterates. Under RLS with no
 * app.tenant_id that query returns zero rows, so the poller silently never
 * polled any mailbox: no receipts, no state transitions, no error.
 *
 * A minimal view exposes ONLY the tenant id and channel name. No credentials,
 * no addresses, nothing decryptable.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE VIEW active_channels AS
      SELECT tenant_id, channel FROM channel_credentials WHERE active = true;
  `);
  pgm.sql('GRANT SELECT ON active_channels TO passo_relay;');
  pgm.sql('GRANT SELECT ON active_channels TO passo_app;');
};

exports.down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS active_channels;');
};
