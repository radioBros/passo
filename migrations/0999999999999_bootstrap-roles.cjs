/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Runtime roles, created BEFORE any migration that grants to them.
 *
 * Ordering matters: a later migration granting to `passo_app` fails with
 * `role "passo_app" does not exist` if the role is only created afterwards by
 * the provisioning script.
 *
 * `passo_app` is created NOLOGIN here and given a password by the provisioning
 * script — a password must never live in a migration file, which is committed.
 */
const ROLES = [
  // The application role. RLS APPLIES to it: no BYPASSRLS, no SUPERUSER.
  ['passo_app', 'NOLOGIN NOSUPERUSER NOBYPASSRLS'],
  // Each of these bypasses RLS for exactly one lookup that cannot know its
  // tenant in advance. Grants are narrowed in the migrations that own them.
  ['passo_auth', 'NOLOGIN BYPASSRLS'],   // resolving a key IS how the tenant is found
  ['passo_router', 'NOLOGIN BYPASSRLS'], // routing a receipt whose tenant is unknown
  ['passo_relay', 'NOLOGIN BYPASSRLS'],  // draining an outbox spanning tenants
  ['passo_purge', 'NOLOGIN BYPASSRLS'],  // pruning across tenants on a schedule
];

exports.up = (pgm) => {
  for (const [name, attrs] of ROLES) {
    pgm.sql(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
          CREATE ROLE ${name} ${attrs};
        END IF;
      END $$;
    `);
  }
};

exports.down = (pgm) => {
  // Roles may own grants elsewhere; dropping them is deliberately manual.
  pgm.sql('-- roles are not dropped automatically');
};
