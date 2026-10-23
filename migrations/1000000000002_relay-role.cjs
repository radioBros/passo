/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * The outbox relay serves every tenant: it drains rows whose tenant_id varies
 * row by row, so it cannot run under a single app.tenant_id context. It gets a
 * dedicated BYPASSRLS role scoped to the outbox table ALONE — no invoices, no
 * credentials, no audit log.
 */
exports.up = (pgm) => {
  // Role created in 0999999999999_bootstrap-roles.
  pgm.sql('GRANT SELECT, UPDATE ON outbox TO passo_relay;');
};

exports.down = (pgm) => {
  pgm.sql('REVOKE ALL ON outbox FROM passo_relay;');
};
