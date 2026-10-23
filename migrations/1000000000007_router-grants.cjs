/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Grants for the correlation_routing view.
 *
 * The view was created in the initial migration but never granted — during
 * development the grant was applied by hand, so a rebuilt database silently
 * lost it and late-receipt routing failed with "permission denied".
 *
 * Grants belong in migrations for exactly this reason: anything applied only
 * by hand is absent from the next clean deployment.
 */
exports.up = (pgm) => {
  // passo_router reads ONLY this view: six columns of identifiers and status,
  // carrying no fiscal or personal data. That narrowness is what makes the
  // BYPASSRLS on this role acceptable.
  pgm.sql('GRANT SELECT ON correlation_routing TO passo_router;');
  // The app role assumes passo_router for the routing lookup, so it must be
  // able to read the view under that role.
  pgm.sql('GRANT SELECT ON correlation_routing TO passo_app;');
};

exports.down = (pgm) => {
  pgm.sql('REVOKE ALL ON correlation_routing FROM passo_router, passo_app;');
};
