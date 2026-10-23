#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { loadConfig } from '../shared/config.ts';
import { logger } from '../shared/logger.ts';
import { createPool, withTx, verifyAuditChain, withQuarantineRole } from '../infra/db/pool.ts';
import { createApiKey, rotateApiKey, revokeApiKey } from '../domain/apikey/service.ts';
import { runPurge } from '../workers/purge.ts';
import { connectBroker } from '../infra/queue/broker.ts';
import { dlqName, QUEUES, EXCHANGES } from '../infra/queue/topology.ts';

/**
 * passo-cli — the operator interface. PASSO is API-only, so the CLI is a thin
 * wrapper: everything it can do is reachable from the Admin API, and it holds
 * no logic of its own.
 */
const USAGE = `passo-cli <command>

  tenant create <name> <slug> <transmitterCode>
  key create <tenantId> <name>
  key rotate <tenantId> <keyId>
  key revoke <tenantId> <keyId>
  dlq list [queue]
  dlq replay <queue>
  quarantine list
  audit verify <tenantId>
  purge run
`;

async function main(): Promise<void> {
  const [, , cmd, sub, ...rest] = process.argv;
  if (!cmd) { console.log(USAGE); process.exit(0); }
  const cfg = loadConfig();
  const db = createPool(cfg);

  try {
    if (cmd === 'tenant' && sub === 'create') {
      const [name, slug, code] = rest;
      const r = await withTx(db, (tx) => tx.query<{ id: string }>(
        `INSERT INTO tenants (name, slug, transmitter_code) VALUES ($1,$2,$3) RETURNING id`,
        [name, slug, code]));
      console.log(r.rows[0]!.id);

    } else if (cmd === 'key' && sub === 'create') {
      const [tenantId, name] = rest;
      const k = await createApiKey(db, tenantId!, name ?? 'default');
      console.log(k.key);
      console.error('store this now — it cannot be retrieved again');

    } else if (cmd === 'key' && sub === 'rotate') {
      const [tenantId, keyId] = rest;
      const k = await rotateApiKey(db, tenantId!, keyId!);
      console.log(k.key);
      console.error('old key stays valid for 7 days');

    } else if (cmd === 'key' && sub === 'revoke') {
      const [tenantId, keyId] = rest;
      await revokeApiKey(db, tenantId!, keyId!);
      console.error('revoked immediately — no grace period');

    } else if (cmd === 'dlq' && sub === 'list') {
      const broker = await connectBroker(cfg.RABBITMQ_URL, logger);
      console.log('dead-letter queues:');
      for (const q of Object.values(QUEUES)) console.log(`  ${dlqName(q)}`);
      await broker.close();

    } else if (cmd === 'dlq' && sub === 'replay') {
      const [queue] = rest;
      if (!queue) { console.error('usage: dlq replay <queue>'); process.exit(1); }
      const broker = await connectBroker(cfg.RABBITMQ_URL, logger);
      let replayed = 0;
      // NOTE: an NS-rejected submission is refused downstream by the retry
      // guard — replaying it would submit a duplicate to the tax authority.
      await broker.consume(queue as never, async (m) => {
        broker.publish(EXCHANGES.invoices, `${m.tenantId}.${queue.replace('dlq.', 'q.')}`,
          { ...m, attempt: 0 });
        replayed++;
      });
      await new Promise((r) => setTimeout(r, 2000));
      console.error(`replayed ${replayed} message(s)`);
      await broker.close();

    } else if (cmd === 'quarantine' && sub === 'list') {
      const r = await withQuarantineRole(db, (tx) => tx.query(
        `SELECT id, type, identificativo_sdi, reason, channel, created_at
           FROM quarantine_index WHERE resolved_at IS NULL
          ORDER BY created_at DESC LIMIT 100`));
      console.log(JSON.stringify(r.rows, null, 2));

    } else if (cmd === 'audit' && sub === 'verify') {
      const [tenantId] = rest;
      const v = await verifyAuditChain(db, tenantId!);
      console.log(JSON.stringify(v));
      if (!v.ok) process.exitCode = 1;

    } else if (cmd === 'purge' && sub === 'run') {
      console.log(JSON.stringify(await runPurge(db, cfg, logger), null, 2));

    } else {
      console.log(USAGE); process.exitCode = 1;
    }
  } finally {
    await db.end().catch(() => undefined);
  }
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
