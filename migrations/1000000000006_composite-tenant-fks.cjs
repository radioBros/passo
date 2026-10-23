/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Cross-tenant reference vulnerability.
 *
 * RLS filters which rows a tenant can SELECT, but a plain
 * `invoices.seller_id REFERENCES sellers(id)` does NOT check that the seller
 * belongs to the SAME tenant. Tenant B could therefore submit an invoice
 * referencing tenant A's seller: RLS is satisfied (invoices.tenant_id is B's)
 * while the invoice is issued under A's legal identity.
 *
 * Fixed with COMPOSITE foreign keys on (tenant_id, id). The database now makes
 * a cross-tenant reference impossible rather than relying on every future query
 * remembering to check.
 */
const PAIRS = [
  // [child, column, parent]
  ['invoices', 'seller_id', 'sellers'],
  ['sdi_submissions', 'invoice_id', 'invoices'],
  ['notifications', 'submission_id', 'sdi_submissions'],
  ['webhook_deliveries', 'webhook_id', 'webhooks'],
];

exports.up = (pgm) => {
  // A composite FK needs a matching composite unique key on the parent.
  for (const parent of ['sellers', 'invoices', 'sdi_submissions', 'webhooks']) {
    pgm.sql(`ALTER TABLE ${parent} ADD CONSTRAINT ${parent}_tenant_id_uk UNIQUE (tenant_id, id);`);
  }
  for (const [child, col, parent] of PAIRS) {
    pgm.sql(`ALTER TABLE ${child} DROP CONSTRAINT IF EXISTS ${child}_${col}_fkey;`);
    pgm.sql(`
      ALTER TABLE ${child}
        ADD CONSTRAINT ${child}_${col}_tenant_fkey
        FOREIGN KEY (tenant_id, ${col}) REFERENCES ${parent} (tenant_id, id)
        ON DELETE RESTRICT;
    `);
  }
};

exports.down = (pgm) => {
  for (const [child, col, parent] of PAIRS) {
    pgm.sql(`ALTER TABLE ${child} DROP CONSTRAINT IF EXISTS ${child}_${col}_tenant_fkey;`);
    pgm.sql(`
      ALTER TABLE ${child} ADD CONSTRAINT ${child}_${col}_fkey
        FOREIGN KEY (${col}) REFERENCES ${parent}(id) ON DELETE RESTRICT;
    `);
  }
  for (const parent of ['sellers', 'invoices', 'sdi_submissions', 'webhooks']) {
    pgm.sql(`ALTER TABLE ${parent} DROP CONSTRAINT IF EXISTS ${parent}_tenant_id_uk;`);
  }
};
