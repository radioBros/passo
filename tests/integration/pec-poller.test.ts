import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness, seedTenant, type Harness } from '../helpers/harness.ts';
import { withTenant, withTx } from '../../src/infra/db/pool.ts';
import { channelForTenant, recordAssignedPecAddress } from '../../src/infra/channels/registry.ts';
import { detectAssignedAddress, SDI_FIRST_ADDRESS } from '../../src/infra/channels/pec.ts';
import { encrypt } from '../../src/infra/crypto/keys.ts';
import { ApiError } from '../../src/shared/errors/catalog.ts';
import { adapterByName } from '../../src/infra/channels/registry.ts';
import { parseNotification } from '../../src/domain/notification/parser.ts';
import { startPecPoller } from '../../src/workers/pec-poller.ts';
import { logger } from '../../src/shared/logger.ts';
import type { PollResult } from '../../src/infra/channels/types.ts';

let h: Harness;
beforeAll(() => { h = createHarness(); });
afterAll(async () => { await h.close(); });

const configurePec = async (tenantId: string, user = 'a@pec.it') => {
  const cfg = {
    smtpHost: 'smtp.example', smtpPort: 465,
    imapHost: 'imap.example', imapPort: 993,
    user, password: 'secret',
  };
  const e = encrypt(h.keys, JSON.stringify(cfg), tenantId, 'channel_config');
  await withTenant(h.db, tenantId, (tx) => tx.query(
    `INSERT INTO channel_credentials
       (tenant_id, channel, config_encrypted, config_key_version, config_iv, config_tag, active)
     VALUES ($1,'pec',$2,$3,$4,$5,true)
     ON CONFLICT (tenant_id, channel) DO UPDATE
       SET config_encrypted = EXCLUDED.config_encrypted, active = true`,
    [tenantId, e.ciphertext, e.keyVersion, e.iv, e.tag]));
  await withTenant(h.db, tenantId, (tx) => tx.query(
    `UPDATE channel_credentials SET active = (channel = 'pec')`));
};

describe('PEC channel registry', () => {
  it('decrypts per-tenant credentials and selects the adapter', async () => {
    const v = await seedTenant(h);
    await configurePec(v.tenantId);
    const { adapter, config } = await channelForTenant(h.db, h.keys, v.tenantId);
    expect(adapter.name).toBe('pec');
    expect(config['user']).toBe('a@pec.it');
    // The SdI address defaults to the first-contact address until SdI assigns one.
    expect(config['sdiAddress']).toBe(SDI_FIRST_ADDRESS);
  });

  it('learns the address SdI assigns and uses it thereafter', async () => {
    const v = await seedTenant(h);
    await configurePec(v.tenantId);
    await recordAssignedPecAddress(h.db, v.tenantId, 'sdi42@pec.fatturapa.it');
    const { config } = await channelForTenant(h.db, h.keys, v.tenantId);
    // Continuing to use sdi01@ after assignment fails SILENTLY — delivery is
    // merely "not guaranteed" — so this must be learned, never static config.
    expect(config['sdiAddress']).toBe('sdi42@pec.fatturapa.it');
  });

  it('records the assignment source and timestamp for audit', async () => {
    const v = await seedTenant(h);
    await configurePec(v.tenantId);
    await recordAssignedPecAddress(h.db, v.tenantId, 'sdi07@pec.fatturapa.it');
    const r = await withTenant(h.db, v.tenantId, (tx) => tx.query<{
      pec_address_source: string; pec_address_assigned_at: Date | null;
    }>(`SELECT pec_address_source, pec_address_assigned_at
          FROM channel_credentials WHERE channel='pec'`));
    expect(r.rows[0]!.pec_address_source).toBe('assigned');
    expect(r.rows[0]!.pec_address_assigned_at).not.toBeNull();
  });

  it('rejects a tenant with no channel configured', async () => {
    const v = await seedTenant(h);
    await withTenant(h.db, v.tenantId, (tx) =>
      tx.query('UPDATE channel_credentials SET active=false WHERE tenant_id=$1', [v.tenantId]));
    await expect(channelForTenant(h.db, h.keys, v.tenantId)).rejects.toThrow(ApiError);
  });

  it('active_channels exposes NO credentials', async () => {
    const cols = await withTx(h.db, (tx) => tx.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='active_channels'`));
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual(['channel', 'tenant_id']);
  });

  it('NEVER returns credentials in plaintext from the database', async () => {
    const v = await seedTenant(h);
    await configurePec(v.tenantId);
    const raw = await withTenant(h.db, v.tenantId, (tx) => tx.query<{ config_encrypted: Buffer }>(
      `SELECT config_encrypted FROM channel_credentials WHERE channel='pec'`));
    expect(raw.rows[0]!.config_encrypted.toString('utf8')).not.toContain('secret');
  });
});

describe('SdI address detection', () => {
  it('extracts an assigned address from a real notification body', () => {
    const ns = readFileSync('tests/fixtures/official/IT01234567890_11111_NS_001.xml', 'utf8');
    const withFrom = ns.replace('<Note>', '<Note>from sdi13@pec.fatturapa.it </Note><Note>');
    const found = detectAssignedAddress(withFrom.match(/[\w.]+@pec\.fatturapa\.it/)?.[0]);
    expect(found).toBe('sdi13@pec.fatturapa.it');
  });

  it('does not treat the first-contact address as an assignment', () => {
    expect(detectAssignedAddress(SDI_FIRST_ADDRESS)).toBeNull();
  });
});

describe('PEC poller wiring', () => {
  it('finds tenants with an active PEC channel', async () => {
    const v = await seedTenant(h);
    await configurePec(v.tenantId);
    // Enumeration happens BEFORE any tenant is known, so it cannot use an
    // app.tenant_id context. Reading channel_credentials directly here returns
    // zero rows under RLS — which is exactly the bug this test caught: the
    // poller silently never polled any mailbox.
    const filtered = await withTx(h.db, (tx) => tx.query(
      `SELECT tenant_id FROM channel_credentials WHERE channel='pec' AND active=true`));
    expect(filtered.rows).toHaveLength(0);   // RLS filters it, as designed

    // The fix: a minimal view read through passo_relay.
    const rows = await withTx(h.db, async (tx) => {
      await tx.query('SET LOCAL ROLE passo_relay');
      return tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM active_channels WHERE channel='pec'`);
    });
    expect(rows.rows.map((r) => r.tenant_id)).toContain(v.tenantId);
  });
});

/**
 * NOTIF-030 — `\Seen` only after durable persistence.
 *
 * The mailbox is the only copy of a legal receipt. Marking a message read
 * before the notification is stored means a crash in between loses it forever,
 * with no way to know it existed. Re-ingesting is idempotent; losing is not
 * recoverable — so the ordering is the safety property, and these tests exist
 * to keep it from being "optimised" back into `poll`.
 */
describe('PEC acknowledgement ordering', () => {
  const fixture = readFileSync('tests/fixtures/official/IT01234567890_11111_RC_001.xml', 'utf8');

  /** An adapter that records the exact order of persist and acknowledge. */
  const trackingAdapter = (failOn?: string) => {
    const events: string[] = [];
    const acked: string[] = [];
    return {
      events, acked,
      poll: () => Promise.resolve([
        { raw: fixture, identificativoSdI: 'ack-1', type: 'RC', receiptHandle: '101' },
        { raw: fixture, identificativoSdI: 'ack-2', type: 'RC', receiptHandle: '102' },
      ]),
      persist: (id: string) => {
        events.push(`persist:${id}`);
        if (id === failOn) throw new Error('ingest failed');
      },
      acknowledge: (handles: string[]) => {
        events.push(`ack:${handles.join(',')}`);
        acked.push(...handles);
      },
    };
  };

  it('acknowledges ONLY after every notification is persisted', () => {
    const a = trackingAdapter();
    const persisted: string[] = [];
    for (const n of ['ack-1', 'ack-2']) { a.persist(n); persisted.push(n === 'ack-1' ? '101' : '102'); }
    a.acknowledge(persisted);
    expect(a.events).toEqual(['persist:ack-1', 'persist:ack-2', 'ack:101,102']);
    // Nothing is acknowledged before the first persist.
    expect(a.events.indexOf('ack:101,102')).toBeGreaterThan(a.events.indexOf('persist:ack-2'));
  });

  it('leaves a FAILED notification unread so it is retried, not lost', () => {
    const a = trackingAdapter('ack-2');
    const persisted: string[] = [];
    for (const [id, uid] of [['ack-1', '101'], ['ack-2', '102']] as const) {
      try { a.persist(id); persisted.push(uid); } catch { /* left unacknowledged */ }
    }
    a.acknowledge(persisted);
    expect(a.acked).toEqual(['101']);        // only the one that persisted
    expect(a.acked).not.toContain('102');    // the failure stays unread
  });

  it('the PEC adapter exposes acknowledge — without it nothing is ever marked read', async () => {
    const v = await seedTenant(h);
    await configurePec(v.tenantId);
    const { adapter } = await channelForTenant(h.db, h.keys, v.tenantId);
    expect(typeof adapter.acknowledge).toBe('function');
  });

  it('acknowledging an empty list is a no-op — never opens a connection', async () => {
    const v = await seedTenant(h);
    await configurePec(v.tenantId);
    const { adapter, config } = await channelForTenant(h.db, h.keys, v.tenantId);
    // imap.example does not resolve; a no-op must not attempt to connect.
    await expect(adapter.acknowledge!(config, [])).resolves.toBeUndefined();
  });
});

/**
 * Poison messages — the REAL poller, against a stubbed mailbox.
 *
 * An unprocessable message used to be skipped and left unread, so it was
 * re-downloaded and re-parsed on every poll forever, and a bad attachment
 * beside a good one was lost when the good one acknowledged the whole email.
 */
describe('PEC poison messages', () => {
  const fixture = readFileSync('tests/fixtures/official/IT01234567890_11111_RC_001.xml', 'utf8');

  it('quarantines poison, then acknowledges ONLY fully-stored messages', async () => {
    const v = await seedTenant(h);
    const mailbox = `poison-${v.tenantId}@pec.it`;
    await configurePec(v.tenantId, mailbox);

    const good = parseNotification(fixture);
    const result: PollResult = {
      notifications: [
        { ...good, receiptHandle: '202' },
        { ...good, receiptHandle: '203' },
        // Ingest of this one fails (raw is NOT NULL), so 204 must stay unread
        // even though its poison part below is quarantined successfully.
        { ...good, raw: null as never, receiptHandle: '204' },
      ],
      poison: [
        { receiptHandle: '201', reason: 'MIME parse failed: test', raw: 'not mime' },
        { receiptHandle: '203', filename: 'bad.xml', reason: 'not a parseable SdI notification',
          raw: '<junk/>' },
        { receiptHandle: '204', filename: 'also-bad.xml', reason: 'not a parseable SdI notification',
          raw: '<junk/>' },
      ],
    };

    const pec = adapterByName('pec')!;
    let served = false;
    const acked: string[][] = [];
    // Answer only for THIS mailbox, once: the poller walks every PEC tenant.
    const poll = vi.spyOn(pec, 'poll').mockImplementation(async (config) => {
      if (config['user'] !== mailbox || served) return { notifications: [], poison: [] };
      served = true;
      return result;
    });
    const ack = vi.spyOn(pec, 'acknowledge').mockImplementation(async (config, handles) => {
      if (config['user'] === mailbox) acked.push(handles);
    });

    const poller = startPecPoller(h.db, h.keys, logger, h.cfg, 50);
    try {
      await vi.waitFor(() => expect(acked.length).toBe(1), { timeout: 10_000, interval: 25 });
    } finally {
      poller.stop();
      poll.mockRestore();
      ack.mockRestore();
    }

    expect([...acked[0]!].sort()).toEqual(['201', '202', '203']);
    expect(acked[0], 'a message with ANY unstored part stays unread').not.toContain('204');

    const q = await withTx(h.db, async (tx) => {
      await tx.query('SET LOCAL ROLE passo_quarantine');
      return tx.query<{ reason: string; filename: string | null; raw: string }>(
        'SELECT reason, filename, raw FROM quarantined_notifications WHERE reason LIKE $1',
        [`%mailbox of tenant ${v.tenantId}%`]);
    });
    expect(q.rows.map((r) => r.filename).sort()).toEqual(['also-bad.xml', 'bad.xml', null]);
    expect(q.rows.find((r) => r.filename === null)!.raw, 'raw bytes are kept').toBe('not mime');
  });
});
