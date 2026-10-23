/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Let the auth path record key usage.
 *
 * `markUsed` has been writing `last_used_at` since the beginning — and silently
 * failing, because `passo_auth` was granted SELECT only. It is fire-and-forget
 * (nobody waits on a usage counter, and awaiting it would put a write on the
 * auth path of every request), so the rejection went nowhere.
 *
 * Measured on a development database: **0 of 189 keys** had ever recorded a
 * `last_used_at`. An operator deciding whether a key is safe to revoke had no
 * signal at all, and `grace_uses` — the whole point of which is to show that a
 * rotated key is still in use — would have stayed at zero forever.
 *
 * The grant is UPDATE on these two columns' table only. `passo_auth` still
 * cannot read or write anything else, and column-level grants would not help:
 * the role needs no other column.
 */
exports.up = (pgm) => {
  /**
   * SELECT is needed alongside UPDATE: Postgres evaluates the WHERE clause
   * against the table, and a column-level UPDATE grant alone leaves the role
   * unable to find the row it is allowed to write ("permission denied for
   * table api_keys"). `passo_auth` already reads these rows through
   * `api_key_auth`, so this widens nothing it could not already see.
   */
  pgm.sql('GRANT SELECT ON api_keys TO passo_auth;');
  pgm.sql('GRANT UPDATE (last_used_at, grace_uses) ON api_keys TO passo_auth;');
  pgm.sql('GRANT SELECT ON mcp_keys TO passo_auth;');
  pgm.sql('GRANT UPDATE (last_used_at) ON mcp_keys TO passo_auth;');
};

exports.down = (pgm) => {
  pgm.sql('REVOKE UPDATE ON api_keys FROM passo_auth;');
  pgm.sql('REVOKE UPDATE ON mcp_keys FROM passo_auth;');
};
