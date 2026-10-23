/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Authentication resolves a key BEFORE the tenant is known — that lookup is
 * precisely how the tenant is determined, so it cannot run under an
 * app.tenant_id context.
 *
 * A dedicated role reads a view exposing only what auth needs: no scopes on
 * other tables, no key material beyond the hash it must compare.
 */
exports.up = (pgm) => {
  // Role created in 0999999999999_bootstrap-roles.
  pgm.sql(`
    CREATE VIEW api_key_auth AS
      SELECT k.id, k.tenant_id, k.key_hash, k.key_prefix, k.scopes,
             k.status, k.expires_at, k.revoked_at
        FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
       WHERE t.status = 'active';
  `);
  pgm.sql('GRANT SELECT ON api_key_auth TO passo_auth;');
  pgm.sql('GRANT UPDATE (last_used_at) ON api_keys TO passo_auth;');
};

exports.down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS api_key_auth;');
  pgm.sql('REVOKE ALL ON api_keys FROM passo_auth;');
};
