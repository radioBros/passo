/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * A transformation is addressed BY NAME, so the name must be unique per tenant.
 *
 * Submission now names the template it wants (`"transformation": "acme-v2"`).
 * Without this constraint, saving the same name twice silently creates a second
 * row and the lookup picks an arbitrary one — so an invoice would be mapped by
 * whichever duplicate the planner happened to return, and the CRM could not tell
 * which. For a document going to a tax authority, "arbitrary but plausible" is
 * the worst possible outcome.
 *
 * The index is on `(tenant_id, name)` rather than `name` alone: two tenants may
 * legitimately both call their mapping "default".
 */
exports.up = (pgm) => {
  // Collapse any pre-existing duplicates, newest wins — they are drafts from
  // before the constraint existed, and the latest save is the intended one.
  pgm.sql(`
    DELETE FROM transformations t
     WHERE EXISTS (
       SELECT 1 FROM transformations n
        WHERE n.tenant_id = t.tenant_id
          AND n.name      = t.name
          AND (n.updated_at, n.id) > (t.updated_at, t.id)
     );
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS transformations_tenant_name_uk
      ON transformations (tenant_id, name);
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS transformations_tenant_name_uk;');
};
