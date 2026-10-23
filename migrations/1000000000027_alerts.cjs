/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Operator and tenant ALERTS.
 *
 * Problems that stop invoices — an OpenAPI.it wallet out of credit, a seller
 * not registered with the vendor, a PEC mailbox password changed at the
 * provider — used to surface only as log lines. Nobody reads logs until
 * invoices are already missing, so these are now alerts, sent by email and/or
 * webhook to the tenant and to the operator.
 *
 *   alert_settings    per-tenant destinations (both optional)
 *   alerts            one row per OPEN problem — deduplicated, counted
 *   alert_deliveries  durable outbox for the notifications themselves
 *
 * Deliveries are dispatched from Postgres, NOT through RabbitMQ: "the broker is
 * unreachable" must itself be alertable.
 *
 * System alerts (audit chain broken, outbox abandoned) have no tenant, so
 * `tenant_id` is nullable on alerts and deliveries. The dedupe index uses
 * NULLS NOT DISTINCT (Postgres 15+): a plain unique index treats NULLs as
 * distinct and would never dedupe a system alert, or an alert with no channel.
 *
 * Cross-tenant work (raising, dispatching, listing for the operator) runs as
 * passo_relay, which is granted exactly these tables.
 */
const rls = (t) => `
  ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS ${t}_tenant_isolation ON ${t};
  CREATE POLICY ${t}_tenant_isolation ON ${t}
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
`;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS alert_settings (
      tenant_id                  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      emails                     text[] NOT NULL DEFAULT '{}',
      webhook_url                text,
      webhook_secret_encrypted   bytea,
      webhook_secret_key_version text,
      webhook_secret_iv          bytea,
      webhook_secret_tag         bytea,
      created_at                 timestamptz NOT NULL DEFAULT now(),
      updated_at                 timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT alert_settings_secret_with_url
        CHECK (webhook_url IS NOT NULL OR webhook_secret_encrypted IS NULL)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id        uuid REFERENCES tenants(id) ON DELETE CASCADE,
      kind             text NOT NULL,
      severity         text NOT NULL,
      channel          text,
      title            text NOT NULL,
      detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurrences      integer NOT NULL DEFAULT 1,
      first_seen_at    timestamptz NOT NULL DEFAULT now(),
      last_seen_at     timestamptz NOT NULL DEFAULT now(),
      last_notified_at timestamptz,
      resolved_at      timestamptz,
      CONSTRAINT alerts_severity_chk CHECK (severity IN ('warning', 'critical'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_uq
      ON alerts (tenant_id, kind, channel) NULLS NOT DISTINCT
      WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS alerts_recent_idx ON alerts (last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS alert_deliveries (
      id              bigserial PRIMARY KEY,
      alert_id        uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      tenant_id       uuid REFERENCES tenants(id) ON DELETE CASCADE,
      event           text NOT NULL,
      destination     text NOT NULL,
      scope           text NOT NULL,
      target          text NOT NULL,
      state           text NOT NULL DEFAULT 'pending',
      attempts        integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error      text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      sent_at         timestamptz,
      CONSTRAINT alert_deliveries_event_chk CHECK (event IN ('alert.firing', 'alert.resolved', 'alert.test')),
      CONSTRAINT alert_deliveries_destination_chk CHECK (destination IN ('email', 'webhook')),
      CONSTRAINT alert_deliveries_scope_chk CHECK (scope IN ('tenant', 'operator')),
      CONSTRAINT alert_deliveries_state_chk CHECK (state IN ('pending', 'sent', 'failed'))
    );
    CREATE INDEX IF NOT EXISTS alert_deliveries_due_idx
      ON alert_deliveries (next_attempt_at) WHERE state = 'pending';
  `);
  pgm.sql(rls('alert_settings') + rls('alerts') + rls('alert_deliveries'));
  pgm.sql(`
    CREATE TRIGGER alert_settings_touch BEFORE UPDATE ON alert_settings
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    GRANT SELECT ON alert_settings, tenants TO passo_relay;
    GRANT SELECT, INSERT, UPDATE ON alerts, alert_deliveries TO passo_relay;
    GRANT USAGE, SELECT ON SEQUENCE alert_deliveries_id_seq TO passo_relay;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS alert_deliveries; DROP TABLE IF EXISTS alerts; DROP TABLE IF EXISTS alert_settings;');
};
