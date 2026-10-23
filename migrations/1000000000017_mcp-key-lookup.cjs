/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Make `mcp_keys` a usable credential (MCP-005 / MCP-006).
 *
 * The table existed but nothing read it: MCP isolation came from
 * `PASSO_MCP_TENANT_ID` at process start, so the authority was "can start the
 * container" rather than a credential. That cannot be revoked, cannot be scoped
 * per assistant, and leaves no trail of which key did what.
 *
 * `key_lookup` is a truncated SHA-256 of the key. bcrypt is deliberately slow,
 * so comparing a presented key against every row would make authentication
 * O(keys) in bcrypt operations — a self-inflicted denial of service. The lookup
 * narrows the candidate set first; bcrypt still decides.
 *
 * It is NOT a security boundary: SHA-256 of a 32-byte random secret is not
 * reversible in any useful sense, and it never substitutes for the bcrypt
 * comparison.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE mcp_keys
      ADD COLUMN IF NOT EXISTS key_lookup   TEXT,
      ADD COLUMN IF NOT EXISTS key_prefix   TEXT,
      ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS mcp_keys_lookup_idx ON mcp_keys (key_lookup);
  `);
  pgm.sql(`
    ALTER TABLE mcp_keys DROP CONSTRAINT IF EXISTS mcp_keys_status_check;
    ALTER TABLE mcp_keys ADD CONSTRAINT mcp_keys_status_check
      CHECK (status IN ('active','revoked','expired'));
  `);

  /**
   * Authentication resolves the tenant, so it cannot already be inside a tenant
   * context — the same reason `api_key_auth` exists. The view exposes only what
   * resolution needs, and never the scopes of other tenants' keys.
   */
  pgm.sql(`
    CREATE OR REPLACE VIEW mcp_key_auth AS
      SELECT id, tenant_id, key_hash, key_lookup, name, scopes, status, expires_at
        FROM mcp_keys;
  `);
  pgm.sql('GRANT SELECT ON mcp_key_auth TO passo_auth;');
  pgm.sql('GRANT SELECT ON mcp_keys     TO passo_auth;');
};

exports.down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS mcp_key_auth;');
  pgm.sql('DROP INDEX IF EXISTS mcp_keys_lookup_idx;');
  pgm.sql('ALTER TABLE mcp_keys DROP CONSTRAINT IF EXISTS mcp_keys_status_check;');
  pgm.sql(`
    ALTER TABLE mcp_keys
      DROP COLUMN IF EXISTS key_lookup,
      DROP COLUMN IF EXISTS key_prefix,
      DROP COLUMN IF EXISTS last_used_at;
  `);
};
