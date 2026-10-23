#!/usr/bin/env node
/**
 * Migration + role provisioning, run once at stack start.
 *
 * Runs as the admin/owner role. Creates the least-privilege runtime roles the
 * application uses, then applies migrations. Idempotent: safe on every boot.
 *
 * The four non-app roles each exist because some lookup legitimately cannot
 * run under a single tenant context:
 *   passo_auth   resolving an API key IS how the tenant is determined
 *   passo_router routing a late receipt whose tenant is unknown
 *   passo_relay  draining an outbox whose rows span tenants
 *   passo_purge  pruning across tenants on a schedule
 * Each is scoped to the narrowest possible surface.
 */
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) { console.error('DATABASE_URL (admin) is required'); process.exit(1); }

const appPassword = process.env.PASSO_DB_PASSWORD;
if (!appPassword) { console.error('PASSO_DB_PASSWORD is required'); process.exit(1); }

const run = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

/**
 * Serialise migrations across replicas with an advisory lock (DEP-010).
 *
 * Three replicas starting together would otherwise all run `up` at once. Some
 * migrations are not safely concurrent — two sessions adding the same
 * constraint race, and `CREATE INDEX` on the same table blocks or errors — and
 * the failure surfaces as one replica crash-looping while the others look fine.
 *
 * A session-level advisory lock costs nothing when uncontended and makes the
 * losers WAIT rather than fail: they then find the migrations already applied
 * and continue, which is exactly the behaviour a rolling deploy needs.
 */
const LOCK_KEY = 0x7061_7373;   // "pass"

const lock = new pg.Client({ connectionString: adminUrl });
await lock.connect();
console.log('→ acquiring migration lock');
await lock.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

try {
  console.log('→ applying migrations');
  // Resolve the local binary rather than shelling out to npx: npx would try to
  // fetch the package at runtime, which needs network and a writable cache.
  run(process.execPath,
      ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '-m', 'migrations'],
      { DATABASE_URL: adminUrl });
} finally {
  await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
  await lock.end().catch(() => undefined);
}

console.log('→ provisioning runtime roles');
const c = new pg.Client({ connectionString: adminUrl });
await c.connect();

// The roles themselves are created by migration 0999999999999, so they exist
// before any migration grants to them. Here we only attach the login password,
// which must never live in a committed migration file.
//
// A DO block cannot take bind parameters, so the literal is escaped explicitly.
const lit = appPassword.replace(/'/g, "''");
await c.query(`ALTER ROLE passo_app WITH LOGIN PASSWORD '${lit}'`);

await c.query(`
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO passo_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO passo_app;
`);

// Future tables inherit the same grants.
await c.query(`
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO passo_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO passo_app;
`);

/**
 * Re-assert quarantine containment (SEC-037).
 *
 * The blanket `GRANT ... ON ALL TABLES` above is deliberately broad, but it
 * runs AFTER migrations and would silently undo migration 1000000000009 — the
 * tenant-scoped role would regain SELECT on other tenants' raw fiscal receipts.
 * Anything narrower than the blanket grant has to be re-applied here, after it.
 */
await c.query(`
  REVOKE ALL ON quarantined_notifications FROM passo_app;
  GRANT INSERT ON quarantined_notifications TO passo_app;
  GRANT passo_quarantine TO passo_app;
`);

/**
 * Reference data is READ-ONLY at runtime.
 *
 * `sdi_error_catalog` is seeded by migration and describes what SdI told us —
 * nothing in the application has any business editing it. Like the quarantine
 * grants above, this has to be re-applied AFTER the blanket
 * `GRANT ... ON ALL TABLES`, which would otherwise hand the app role
 * INSERT/UPDATE/DELETE on it.
 */
await c.query(`
  REVOKE ALL ON sdi_error_catalog FROM passo_app;
  GRANT SELECT ON sdi_error_catalog TO passo_app;
`);

/**
 * Every bypass role must be ASSUMED, never inherited.
 *
 * Postgres 16 made inheritance a property of the *membership*, not only of the
 * role: `pg_auth_members.inherit_option`. A plain `GRANT role TO passo_app`
 * records `inherit_option = true`, and `ALTER ROLE passo_app NOINHERIT` does
 * NOT change already-granted memberships — so `passo_app` silently held every
 * bypass role's privileges ambiently, without any `SET LOCAL ROLE`.
 *
 * That defeats the point of having separate roles: the narrow, auditable paths
 * in the code were the only thing keeping them apart, with nothing in the
 * database enforcing it. `WITH INHERIT FALSE` makes the privilege unreachable
 * until the code explicitly assumes the role.
 */
await c.query(`ALTER ROLE passo_app NOINHERIT;`);
for (const role of ['passo_router', 'passo_relay', 'passo_purge', 'passo_auth', 'passo_quarantine']) {
  await c.query(`GRANT ${role} TO passo_app WITH INHERIT FALSE;`);
}

// passo_app must never bypass RLS — that is the whole isolation guarantee.
const check = await c.query(
  `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='passo_app'`);
const row = check.rows[0];
if (row?.rolbypassrls || row?.rolsuper) {
  console.error('FATAL: passo_app has BYPASSRLS or SUPERUSER — tenant isolation is void');
  process.exit(1);
}

await c.end();
console.log('→ roles provisioned; passo_app verified NOSUPERUSER NOBYPASSRLS');
