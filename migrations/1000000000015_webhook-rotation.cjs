/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Dual-secret rotation for webhook subscriptions (WH-007).
 *
 * Rotating a signing secret is otherwise a coordinated outage: the moment PASSO
 * starts signing with a new secret, every delivery fails signature verification
 * until the receiver has redeployed. Receivers therefore avoid rotating at all,
 * which is the opposite of what a signing secret is for.
 *
 * During the overlap window PASSO signs with BOTH secrets and sends both `v1=`
 * values in one header, so a receiver accepts either while it rolls out. The
 * window is bounded — an old secret that never expires is just a second live
 * credential.
 *
 * `secret_prefix` exists so a subscription can be identified in a list without
 * ever returning the secret: it is shown once at creation and never again.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE webhooks
      ADD COLUMN IF NOT EXISTS previous_secret_encrypted   BYTEA,
      ADD COLUMN IF NOT EXISTS previous_secret_key_version TEXT,
      ADD COLUMN IF NOT EXISTS previous_secret_iv          BYTEA,
      ADD COLUMN IF NOT EXISTS previous_secret_tag         BYTEA,
      ADD COLUMN IF NOT EXISTS previous_secret_expires_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS secret_prefix               TEXT,
      ADD COLUMN IF NOT EXISTS description                 TEXT,
      ADD COLUMN IF NOT EXISTS disabled_reason             TEXT,
      ADD COLUMN IF NOT EXISTS consecutive_failures        INTEGER NOT NULL DEFAULT 0;
  `);

  // The overlap must be all-or-nothing: a previous secret with no expiry would
  // stay valid forever, which is a second live credential rather than a
  // rotation. Enforced by the database because the cost of getting it wrong is
  // silent and permanent.
  pgm.sql(`
    ALTER TABLE webhooks
      DROP CONSTRAINT IF EXISTS webhooks_previous_secret_bounded;
    ALTER TABLE webhooks
      ADD CONSTRAINT webhooks_previous_secret_bounded CHECK (
        (previous_secret_encrypted IS NULL AND previous_secret_expires_at IS NULL)
        OR
        (previous_secret_encrypted IS NOT NULL AND previous_secret_expires_at IS NOT NULL)
      );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS webhooks_overlap_idx
      ON webhooks (previous_secret_expires_at)
      WHERE previous_secret_expires_at IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS webhooks_overlap_idx;');
  pgm.sql('ALTER TABLE webhooks DROP CONSTRAINT IF EXISTS webhooks_previous_secret_bounded;');
  pgm.sql(`
    ALTER TABLE webhooks
      DROP COLUMN IF EXISTS previous_secret_encrypted,
      DROP COLUMN IF EXISTS previous_secret_key_version,
      DROP COLUMN IF EXISTS previous_secret_iv,
      DROP COLUMN IF EXISTS previous_secret_tag,
      DROP COLUMN IF EXISTS previous_secret_expires_at,
      DROP COLUMN IF EXISTS secret_prefix,
      DROP COLUMN IF EXISTS description,
      DROP COLUMN IF EXISTS disabled_reason,
      DROP COLUMN IF EXISTS consecutive_failures;
  `);
};
