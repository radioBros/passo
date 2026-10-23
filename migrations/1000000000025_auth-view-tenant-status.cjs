/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Restore the tenant-status filter to `api_key_auth`.
 *
 * Migration 1000000000004 defined this view with
 * `JOIN tenants t ON t.id = k.tenant_id WHERE t.status = 'active'`, so
 * suspending a tenant immediately stopped every one of its keys.
 *
 * Migration 1000000000022 rebuilt the view with `CREATE OR REPLACE` to add
 * `grace_expires_at` and silently dropped that join. `resolveApiKey` checks
 * revocation, expiry and the grace window — and nothing about the tenant — so
 * from that point a SUSPENDED OR DEACTIVATED TENANT KEPT AUTHENTICATING and
 * kept transmitting invoices.
 *
 * Suspension is the operator's lever for non-payment, abuse and incident
 * response. A lever that does nothing is worse than none, because it is
 * believed.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW api_key_auth AS
      SELECT k.id, k.tenant_id, k.key_hash, k.key_prefix, k.scopes, k.status,
             k.expires_at, k.revoked_at, k.grace_expires_at
        FROM api_keys k
        JOIN tenants t ON t.id = k.tenant_id
       WHERE t.status = 'active';
  `);
  pgm.sql('GRANT SELECT ON api_key_auth TO passo_auth;');

  // The MCP path has the same requirement and the same omission.
  pgm.sql(`
    CREATE OR REPLACE VIEW mcp_key_auth AS
      SELECT k.id, k.tenant_id, k.key_hash, k.key_lookup, k.name, k.scopes,
             k.status, k.expires_at
        FROM mcp_keys k
        JOIN tenants t ON t.id = k.tenant_id
       WHERE t.status = 'active';
  `);
  pgm.sql('GRANT SELECT ON mcp_key_auth TO passo_auth;');
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW api_key_auth AS
      SELECT id, tenant_id, key_hash, key_prefix, scopes, status,
             expires_at, revoked_at, grace_expires_at
        FROM api_keys;
  `);
};
