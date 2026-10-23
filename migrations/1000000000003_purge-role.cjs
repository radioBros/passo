/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * The purge job operates across every tenant, so like the outbox relay it
 * cannot run under a single app.tenant_id. It gets a dedicated BYPASSRLS role
 * scoped to exactly the tables it prunes.
 */
exports.up = (pgm) => {
  // Role created in 0999999999999_bootstrap-roles.
  pgm.sql(`
    GRANT SELECT, UPDATE ON sdi_submissions, invoices TO passo_purge;
    GRANT SELECT, DELETE ON notifications, correlation_records, audit_log TO passo_purge;
    GRANT INSERT ON audit_log TO passo_purge;
    GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO passo_purge;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    REVOKE ALL ON sdi_submissions, invoices, notifications,
                  correlation_records, audit_log FROM passo_purge;
  `);
};
