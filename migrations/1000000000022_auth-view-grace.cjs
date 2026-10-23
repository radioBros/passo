/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Expose `grace_expires_at` to the authentication path.
 *
 * `api_key_auth` is what `passo_auth` reads, and resolution happens before any
 * tenant context exists. Without this column the resolver cannot tell whether a
 * grace window is still open, so a rotated key would either authenticate
 * forever or not at all — neither of which is a rotation.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW api_key_auth AS
      SELECT id, tenant_id, key_hash, key_prefix, scopes, status,
             expires_at, revoked_at, grace_expires_at
        FROM api_keys;
  `);
  pgm.sql('GRANT SELECT ON api_key_auth TO passo_auth;');
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW api_key_auth AS
      SELECT id, tenant_id, key_hash, key_prefix, scopes, status,
             expires_at, revoked_at
        FROM api_keys;
  `);
};
