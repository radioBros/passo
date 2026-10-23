/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Per-tenant inbound webhook secrets (SDI-026 / NOTIF-007).
 *
 * Invoicetronic and OpenAPI.it PUSH notifications to us, so PASSO needs a
 * publicly reachable endpoint. That endpoint changes invoice state, which makes
 * it the highest-value forgery target in the system: a forged NS would tell a
 * CRM its invoice was rejected when it was not, and NS is terminal — the CRM
 * would issue a replacement invoice for a document that is perfectly valid.
 *
 * Each tenant-channel pair gets its own token, so a leak is contained to one
 * tenant and revocable without touching anyone else. The token is in the URL
 * path rather than a header because vendor webhook configuration UIs commonly
 * do not offer custom headers — a header-only design would be unusable with the
 * very vendors it exists to serve.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE channel_credentials
      ADD COLUMN IF NOT EXISTS inbound_token_hash TEXT,
      ADD COLUMN IF NOT EXISTS inbound_token_lookup TEXT;
  `);
  // The lookup narrows the candidate set so bcrypt runs once, not per row.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS channel_credentials_inbound_lookup_idx
      ON channel_credentials (inbound_token_lookup)
      WHERE inbound_token_lookup IS NOT NULL;
  `);

  /**
   * Resolution happens BEFORE the tenant is known — the token is what
   * identifies it — so it cannot run inside a tenant context. The view exposes
   * only what resolution needs: no credentials, no configuration.
   */
  pgm.sql(`
    CREATE OR REPLACE VIEW inbound_webhook_auth AS
      SELECT tenant_id, channel, inbound_token_hash, inbound_token_lookup
        FROM channel_credentials
       WHERE inbound_token_hash IS NOT NULL AND active = true;
  `);
  pgm.sql('GRANT SELECT ON inbound_webhook_auth TO passo_auth;');
};

exports.down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS inbound_webhook_auth;');
  pgm.sql('DROP INDEX IF EXISTS channel_credentials_inbound_lookup_idx;');
  pgm.sql(`
    ALTER TABLE channel_credentials
      DROP COLUMN IF EXISTS inbound_token_hash,
      DROP COLUMN IF EXISTS inbound_token_lookup;
  `);
};
