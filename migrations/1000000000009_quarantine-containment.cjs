/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Contain quarantined receipts (SEC-037).
 *
 * A quarantined notification is a receipt whose owning tenant could NOT be
 * determined — so the table has no tenant_id and no RLS policy can scope it.
 * That is correct by design, but it made the table a cross-tenant hole:
 * `passo_app`, the tenant-scoped application role, held full SELECT on it and
 * could read every tenant's raw fiscal receipt regardless of tenant context.
 *
 * SEC-037 requires the payload be "unreadable by any tenant-scoped role".
 * Containment therefore has to come from GRANTs, since RLS cannot help here:
 *
 *   - `passo_app` loses SELECT on the raw payload entirely.
 *   - `passo_quarantine` (NOINHERIT, assumed deliberately) reads it, for the
 *     operator surfaces — Admin API and CLI — that trace an orphaned receipt.
 *   - `passo_app` keeps INSERT only, because the ingest path must still be able
 *     to quarantine an unmatched receipt. Writing is not reading.
 *
 * A metadata-only view carries the operator listing, so the common case never
 * touches the raw XML at all.
 */
exports.up = (pgm) => {
  // SEC-037 requires re-association to name its actor. Without this column the
  // audit entry could say a receipt was re-associated but never by whom.
  pgm.sql('ALTER TABLE quarantined_notifications ADD COLUMN IF NOT EXISTS resolved_by TEXT;');

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passo_quarantine') THEN
        CREATE ROLE passo_quarantine NOLOGIN NOINHERIT;
      END IF;
    END $$;
  `);

  // The raw payload is readable ONLY under the dedicated role.
  pgm.sql('REVOKE ALL ON quarantined_notifications FROM passo_app;');
  pgm.sql('GRANT INSERT ON quarantined_notifications TO passo_app;');
  pgm.sql('GRANT SELECT, UPDATE ON quarantined_notifications TO passo_quarantine;');
  pgm.sql('GRANT passo_quarantine TO passo_app;');

  /**
   * Metadata only — deliberately WITHOUT `raw`. Listing orphaned receipts is a
   * routine operator action; reading a stranger's fiscal payload is not, and
   * the two should not share a query.
   */
  pgm.sql(`
    CREATE OR REPLACE VIEW quarantine_index AS
      SELECT id, reason, type, identificativo_sdi, filename, channel,
             resolved_at, resolved_by, created_at
        FROM quarantined_notifications;
  `);
  pgm.sql('GRANT SELECT ON quarantine_index TO passo_quarantine;');
  pgm.sql('GRANT SELECT ON quarantine_index TO passo_app;');
};

exports.down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS quarantine_index;');
  pgm.sql('ALTER TABLE quarantined_notifications DROP COLUMN IF EXISTS resolved_by;');
  pgm.sql('REVOKE ALL ON quarantined_notifications FROM passo_quarantine;');
  pgm.sql('GRANT SELECT, INSERT, UPDATE, DELETE ON quarantined_notifications TO passo_app;');
};
