/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Usage metering (KEY-003).
 *
 * An operator running PASSO for several CRMs needs to answer "who is using
 * this, how much, and is anyone failing?" — and needs to answer it without
 * reading logs, because logs are redacted and rotated.
 *
 * `tenant_id` is denormalised deliberately. Aggregating per tenant is the whole
 * point of the table, and joining `api_keys` to reach it would put the join
 * inside every RLS policy evaluation — the aggregate would then be as expensive
 * as the traffic it measures.
 *
 * Rows are written by a buffered flush, never on the request path: a
 * synchronous INSERT per request would make metering the slowest thing in a
 * fast handler.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS api_key_usage (
      id           BIGSERIAL PRIMARY KEY,
      tenant_id    UUID        NOT NULL,
      key_id       UUID,
      route        TEXT        NOT NULL,
      method       TEXT        NOT NULL,
      status       INTEGER     NOT NULL,
      duration_ms  INTEGER     NOT NULL,
      at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Aggregation is always "this tenant, this window", so the index matches.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS api_key_usage_tenant_at_idx
      ON api_key_usage (tenant_id, at DESC);
    CREATE INDEX IF NOT EXISTS api_key_usage_at_idx ON api_key_usage (at);
  `);

  pgm.sql('ALTER TABLE api_key_usage ENABLE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE api_key_usage FORCE ROW LEVEL SECURITY;');
  pgm.sql(`
    DROP POLICY IF EXISTS api_key_usage_tenant_isolation ON api_key_usage;
    CREATE POLICY api_key_usage_tenant_isolation ON api_key_usage
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  `);

  // The flush runs outside any single tenant context — one batch spans tenants
  // — so it writes under passo_relay, the same role the outbox drain uses.
  pgm.sql('GRANT SELECT, INSERT ON api_key_usage TO passo_relay;');
  pgm.sql('GRANT USAGE, SELECT ON SEQUENCE api_key_usage_id_seq TO passo_relay;');
  pgm.sql('GRANT SELECT, DELETE ON api_key_usage TO passo_purge;');
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS api_key_usage;');
};
