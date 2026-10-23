/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Fix: with no app.tenant_id set, `current_setting('app.tenant_id', true)`
 * returns '' (empty string), and `''::uuid` RAISES rather than yielding NULL.
 *
 * A raised error is not the same as fail-closed. It surfaces as a 500 instead
 * of an empty result, and any code path that catches-and-continues could
 * misread it. The policy must evaluate to FALSE, cleanly.
 *
 * NULLIF(...,'') turns the unset case into NULL, and `tenant_id = NULL` is
 * NULL -> not true -> row filtered. Zero rows, no exception.
 */
const TENANT_SCOPED = [
  'sellers', 'invoices', 'sdi_submissions', 'correlation_records', 'notifications',
  'outbox', 'api_keys', 'mcp_keys', 'webhooks', 'webhook_deliveries',
  'transformations', 'channel_credentials', 'idempotency_keys', 'audit_log',
];

exports.up = (pgm) => {
  for (const t of TENANT_SCOPED) {
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${t};`);
    pgm.sql(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    `);
  }
};

exports.down = (pgm) => {
  for (const t of TENANT_SCOPED) {
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${t};`);
    pgm.sql(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    `);
  }
};
