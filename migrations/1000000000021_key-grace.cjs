/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Key rotation with a grace window (KEY-010 / KEY-011).
 *
 * Without a grace period, rotating an API key is a coordinated outage: the
 * moment the new key is issued, every request still carrying the old one fails.
 * So operators avoid rotating, which defeats the point of having rotatable
 * credentials at all.
 *
 * During the window BOTH keys authenticate. The old one returns `Deprecation`
 * and `Sunset` headers, and its usage is counted — so an operator can see
 * "old key still in use, 400 requests yesterday" and chase the caller before
 * the window closes rather than discovering it when traffic stops.
 *
 * Distinct from revocation, which is the incident-response tool and has no
 * grace at all.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE api_keys
      ADD COLUMN IF NOT EXISTS grace_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS revoke_reason    TEXT,
      ADD COLUMN IF NOT EXISTS grace_uses       INTEGER NOT NULL DEFAULT 0;
  `);

  // A grace key must always have an expiry: one without would authenticate
  // forever, which is a second live credential rather than a rotation.
  pgm.sql(`
    ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_grace_bounded;
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_grace_bounded CHECK (
      status <> 'grace' OR grace_expires_at IS NOT NULL
    );
  `);

  pgm.sql(`
    ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_status_check;
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_status_check
      CHECK (status IN ('active','rotating','grace','revoked','expired'));
  `);

  // The sweep looks for elapsed grace windows and expiries.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS api_keys_grace_idx
      ON api_keys (grace_expires_at) WHERE grace_expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS api_keys_expiry_idx
      ON api_keys (expires_at) WHERE expires_at IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS api_keys_grace_idx;');
  pgm.sql('DROP INDEX IF EXISTS api_keys_expiry_idx;');
  pgm.sql('ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_grace_bounded;');
  pgm.sql(`
    ALTER TABLE api_keys
      DROP COLUMN IF EXISTS grace_expires_at,
      DROP COLUMN IF EXISTS revoke_reason,
      DROP COLUMN IF EXISTS grace_uses;
  `);
};
