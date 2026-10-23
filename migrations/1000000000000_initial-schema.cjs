/* eslint-disable camelcase */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  // ---------------------------------------------------------------- tenants
  // NOT tenant-scoped: this is the tenancy root, read during tenant resolution
  // before any app.tenant_id context exists.
  pgm.createTable('tenants', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true, unique: true },
    status: { type: 'text', notNull: true, default: 'active' },
    transmitter_country: { type: 'text', notNull: true, default: 'IT' },
    transmitter_code: { type: 'text', notNull: true },
    settings: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('tenants', 'tenants_status_chk',
    "CHECK (status IN ('active','suspended','deactivated'))");

  // ------------------------------------------------------- encryption_keys
  // NOT tenant-scoped. Key MATERIAL never lives here — only metadata.
  pgm.createTable('encryption_keys', {
    version: { type: 'text', primaryKey: true },
    algorithm: { type: 'text', notNull: true, default: 'AES-256-GCM' },
    state: { type: 'text', notNull: true, default: 'active' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    retired_at: { type: 'timestamptz' },
  });

  // ---------------------------------------------------------------- sellers
  pgm.createTable('sellers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    vat_country: { type: 'text' },
    vat_code: { type: 'text' },
    tax_code: { type: 'text' },
    denomination: { type: 'text' },
    first_name: { type: 'text' },
    last_name: { type: 'text' },
    tax_regime: { type: 'text', notNull: true },
    address: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('sellers', 'sellers_name_chk',
    'CHECK ((denomination IS NOT NULL) OR (first_name IS NOT NULL AND last_name IS NOT NULL))');
  pgm.createIndex('sellers', ['tenant_id', 'vat_code']);

  // --------------------------------------------------------------- invoices
  // payload + generated XML are TRANSIENT: purged once a terminal receipt
  // arrives (stateless_relay_decision). There is deliberately NO retention_until.
  pgm.createTable('invoices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    seller_id: { type: 'uuid', notNull: true, references: 'sellers', onDelete: 'RESTRICT' },
    crm_invoice_ref: { type: 'text' },
    invoice_number: { type: 'text', notNull: true },
    document_type: { type: 'text', notNull: true },
    issue_date: { type: 'date', notNull: true },
    currency: { type: 'text', notNull: true, default: 'EUR' },
    format_trasmissione: { type: 'text', notNull: true },
    recipient_code: { type: 'text', notNull: true },
    recipient_pec: { type: 'text' },
    total_amount: { type: 'numeric(19,8)' },
    payload_encrypted: { type: 'bytea' },
    payload_key_version: { type: 'text' },
    payload_iv: { type: 'bytea' },
    payload_tag: { type: 'bytea' },
    purged_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('invoices', 'invoices_unique_number',
    { unique: ['tenant_id', 'seller_id', 'invoice_number'] });

  // -------------------------------------------------------- sdi_submissions
  pgm.createTable('sdi_submissions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    invoice_id: { type: 'uuid', notNull: true, references: 'invoices', onDelete: 'RESTRICT' },
    transmitter_id: { type: 'text', notNull: true },
    progressivo_invio: { type: 'text', notNull: true },
    channel: { type: 'text', notNull: true },
    xml_filename: { type: 'text' },
    xml_sha256: { type: 'text' },
    xml_encrypted: { type: 'bytea' },
    xml_key_version: { type: 'text' },
    xml_iv: { type: 'bytea' },
    xml_tag: { type: 'bytea' },
    signature_present: { type: 'boolean', notNull: true, default: false },
    schema_version: { type: 'text', notNull: true, default: 'VFPR12_v1.2.3' },
    state: { type: 'text', notNull: true, default: 'queued' },
    identificativo_sdi: { type: 'text' },
    pec_message_id: { type: 'text' },
    attempt_no: { type: 'integer', notNull: true, default: 0 },
    submitted_at: { type: 'timestamptz' },
    terminal_at: { type: 'timestamptz' },
    purged_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // ProgressivoInvio must be unique per transmitter. An NS retry allocates a NEW value.
  pgm.addConstraint('sdi_submissions', 'sdi_progressivo_unique',
    { unique: ['transmitter_id', 'progressivo_invio'] });
  pgm.createIndex('sdi_submissions', ['tenant_id', 'state']);
  pgm.createIndex('sdi_submissions', 'identificativo_sdi');

  // ---------------------------------------------------- correlation_records
  // The forwarding address. Holds IDs and status ONLY — no buyer/seller
  // identity, no amounts, no XML. This is what keeps PASSO out of scope for
  // the 10-year retention and conservazione obligations.
  pgm.createTable('correlation_records', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    submission_id: { type: 'uuid', notNull: true },
    crm_invoice_ref: { type: 'text' },
    progressivo_invio: { type: 'text', notNull: true },
    transmitter_id: { type: 'text', notNull: true },
    identificativo_sdi: { type: 'text' },
    pec_message_id: { type: 'text' },
    status: { type: 'text', notNull: true },
    transmitted_at: { type: 'timestamptz' },
    terminal_at: { type: 'timestamptz' },
    expires_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('correlation_records', 'identificativo_sdi');
  pgm.createIndex('correlation_records', 'pec_message_id');
  pgm.createIndex('correlation_records', ['transmitter_id', 'progressivo_invio']);
  pgm.createIndex('correlation_records', 'expires_at');

  // ----------------------------------------------------------- notifications
  pgm.createTable('notifications', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    submission_id: { type: 'uuid', references: 'sdi_submissions', onDelete: 'RESTRICT' },
    type: { type: 'text', notNull: true },
    identificativo_sdi: { type: 'text' },
    sdi_message_id: { type: 'text' },
    raw_encrypted: { type: 'bytea' },
    raw_key_version: { type: 'text' },
    raw_iv: { type: 'bytea' },
    raw_tag: { type: 'bytea' },
    parsed: { type: 'jsonb' },
    channel: { type: 'text', notNull: true },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    acknowledged_at: { type: 'timestamptz' },
    ack_method: { type: 'text' },
    purge_eligible_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('notifications', 'notifications_type_chk',
    "CHECK (type IN ('RC','NS','MC','NE','DT','AT','MT','EC','SE'))");
  // An unacknowledged receipt can NEVER become purge-eligible.
  pgm.addConstraint('notifications', 'notifications_purge_requires_ack',
    'CHECK (purge_eligible_at IS NULL OR acknowledged_at IS NOT NULL)');
  pgm.addConstraint('notifications', 'notifications_dedupe',
    { unique: ['tenant_id', 'submission_id', 'type', 'sdi_message_id'] });

  // ------------------------------------------------------- quarantined msgs
  // A notification that matches no correlation record is NEVER discarded.
  pgm.createTable('quarantined_notifications', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    reason: { type: 'text', notNull: true },
    type: { type: 'text' },
    identificativo_sdi: { type: 'text' },
    filename: { type: 'text' },
    raw: { type: 'text', notNull: true },
    channel: { type: 'text', notNull: true },
    resolved_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // ----------------------------------------------------------------- outbox
  pgm.createTable('outbox', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    exchange: { type: 'text', notNull: true },
    routing_key: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    published_at: { type: 'timestamptz' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('outbox', 'id', { where: 'published_at IS NULL', name: 'outbox_unpublished_idx' });

  // --------------------------------------------------------------- api_keys
  pgm.createTable('api_keys', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    key_hash: { type: 'text', notNull: true, unique: true },
    key_prefix: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    environment: { type: 'text', notNull: true, default: 'live' },
    scopes: { type: 'text[]', notNull: true, default: '{}' },
    status: { type: 'text', notNull: true, default: 'active' },
    expires_at: { type: 'timestamptz' },
    last_used_at: { type: 'timestamptz' },
    rotated_from: { type: 'uuid' },
    revoked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('api_keys', ['tenant_id', 'status']);

  pgm.createTable('mcp_keys', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    key_hash: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    scopes: { type: 'text[]', notNull: true, default: '{}' },
    status: { type: 'text', notNull: true, default: 'active' },
    expires_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // --------------------------------------------------------------- webhooks
  pgm.createTable('webhooks', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    url: { type: 'text', notNull: true },
    events: { type: 'text[]', notNull: true, default: '{}' },
    secret_encrypted: { type: 'bytea', notNull: true },
    secret_key_version: { type: 'text', notNull: true },
    secret_iv: { type: 'bytea', notNull: true },
    secret_tag: { type: 'bytea', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('webhook_deliveries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    webhook_id: { type: 'uuid', notNull: true, references: 'webhooks', onDelete: 'CASCADE' },
    submission_id: { type: 'uuid' },
    event_id: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    attempt: { type: 'integer', notNull: true, default: 0 },
    http_status: { type: 'integer' },
    error: { type: 'text' },
    delivered_at: { type: 'timestamptz' },
    next_retry_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('webhook_deliveries', ['tenant_id', 'webhook_id']);
  pgm.createIndex('webhook_deliveries', 'next_retry_at');

  // -------------------------------------------------------- transformations
  pgm.createTable('transformations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    name: { type: 'text', notNull: true },
    source_format: { type: 'text' },
    rules: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // ----------------------------------------------------- channel_credentials
  pgm.createTable('channel_credentials', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    channel: { type: 'text', notNull: true },
    config_encrypted: { type: 'bytea', notNull: true },
    config_key_version: { type: 'text', notNull: true },
    config_iv: { type: 'bytea', notNull: true },
    config_tag: { type: 'bytea', notNull: true },
    // PEC: SdI assigns a per-transmitter address after the first submission.
    // Learned state, never static configuration.
    pec_sdi_address: { type: 'text', default: 'sdi01@pec.fatturapa.it' },
    pec_address_source: { type: 'text', default: 'default' },
    pec_address_assigned_at: { type: 'timestamptz' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('channel_credentials', 'channel_unique',
    { unique: ['tenant_id', 'channel'] });

  // ------------------------------------------------------ idempotency_keys
  pgm.createTable('idempotency_keys', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    key: { type: 'text', notNull: true },
    request_hash: { type: 'text', notNull: true },
    response: { type: 'jsonb' },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('idempotency_keys', 'idempotency_unique', { unique: ['tenant_id', 'key'] });

  // -------------------------------------------------------------- audit_log
  // HASH-CHAINED: each row's hash covers the previous row's hash, so deletion
  // and reordering are detectable, not merely field edits.
  pgm.createTable('audit_log', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', references: 'tenants', onDelete: 'RESTRICT' },
    actor: { type: 'text', notNull: true },
    action: { type: 'text', notNull: true },
    resource_type: { type: 'text' },
    resource_id: { type: 'text' },
    detail: { type: 'jsonb' },
    ip: { type: 'inet' },
    prev_hash: { type: 'text' },
    hash: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('audit_log', ['tenant_id', 'created_at']);

  // ------------------------------------------------------------------- RLS
  const TENANT_SCOPED = [
    'sellers', 'invoices', 'sdi_submissions', 'correlation_records', 'notifications',
    'outbox', 'api_keys', 'mcp_keys', 'webhooks', 'webhook_deliveries',
    'transformations', 'channel_credentials', 'idempotency_keys', 'audit_log',
  ];
  for (const t of TENANT_SCOPED) {
    pgm.sql(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`);
    // WITH CHECK is mandatory: USING alone blocks reads but still permits
    // INSERTing a row belonging to another tenant.
    pgm.sql(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    `);
  }

  // Routing view for late-receipt correlation: the tenant is UNKNOWN at lookup
  // time, so this is the single sanctioned RLS bypass. Six columns, no fiscal
  // or personal data. See receipt_routing_role_decision.
  pgm.sql(`
    CREATE VIEW correlation_routing AS
      SELECT tenant_id, submission_id, crm_invoice_ref,
             progressivo_invio, identificativo_sdi, pec_message_id, status
      FROM correlation_records;
  `);

  // updated_at touch trigger
  pgm.sql(`
    CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
  `);
  for (const t of ['tenants', 'sellers', 'invoices', 'sdi_submissions',
    'correlation_records', 'webhooks', 'transformations', 'channel_credentials']) {
    pgm.sql(`CREATE TRIGGER ${t}_touch BEFORE UPDATE ON ${t}
             FOR EACH ROW EXECUTE FUNCTION touch_updated_at();`);
  }
};

exports.down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS correlation_routing;');
  for (const t of ['audit_log', 'idempotency_keys', 'channel_credentials', 'transformations',
    'webhook_deliveries', 'webhooks', 'mcp_keys', 'api_keys', 'outbox',
    'quarantined_notifications', 'notifications', 'correlation_records',
    'sdi_submissions', 'invoices', 'sellers', 'encryption_keys', 'tenants']) {
    pgm.dropTable(t, { ifExists: true, cascade: true });
  }
  pgm.sql('DROP FUNCTION IF EXISTS touch_updated_at();');
};
