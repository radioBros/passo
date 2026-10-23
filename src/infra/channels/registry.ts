import type { Db } from '../db/pool.ts';
import { withTenant, audit } from '../db/pool.ts';
import { decryptString, type KeyProvider } from '../crypto/keys.ts';
import type { SdiChannelAdapter } from './types.ts';
import { MockChannel } from './mock.ts';
import { PecChannel } from './pec.ts';
import { InvoicetronicChannel } from './invoicetronic.ts';
import { OpenApiChannel } from './openapi.ts';
import { ApiError } from '../../shared/errors/catalog.ts';

const ADAPTERS: Record<string, SdiChannelAdapter> = {
  mock: new MockChannel(),
  pec: new PecChannel(),
  invoicetronic: new InvoicetronicChannel(),
  openapi: new OpenApiChannel(),
};

export const adapterByName = (n: string): SdiChannelAdapter | undefined => ADAPTERS[n];

/** Resolve a tenant's configured channel and decrypt its credentials. */
export async function channelForTenant(
  db: Db, keys: KeyProvider, tenantId: string,
): Promise<{ adapter: SdiChannelAdapter; config: Record<string, unknown> }> {
  const r = await withTenant(db, tenantId, (tx) => tx.query<{
    channel: string; config_encrypted: Buffer; config_key_version: string;
    config_iv: Buffer; config_tag: Buffer; pec_sdi_address: string | null;
  }>(
    `SELECT channel, config_encrypted, config_key_version, config_iv, config_tag, pec_sdi_address
       FROM channel_credentials WHERE active = true ORDER BY updated_at DESC LIMIT 1`,
  ));
  const row = r.rows[0];
  if (!row) throw new ApiError('ERR_CHANNEL_NOT_CONFIGURED');
  const adapter = ADAPTERS[row.channel];
  if (!adapter) throw new ApiError('ERR_CHANNEL_NOT_CONFIGURED', `unknown channel "${row.channel}"`);

  // Decryption yields bytes we believe we wrote, but a key-rotation error or a
  // corrupted row would surface here as an opaque SyntaxError. Fail with a
  // channel error the operator can act on instead.
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(decryptString(keys, {
      ciphertext: row.config_encrypted, iv: row.config_iv,
      tag: row.config_tag, keyVersion: row.config_key_version,
    }, tenantId, 'channel_config')) as Record<string, unknown>;
  } catch (e) {
    throw new ApiError('ERR_CHANNEL_NOT_CONFIGURED',
      `stored credentials for "${row.channel}" could not be read — check encryption key rotation (${(e as Error).message})`);
  }

  // The SdI PEC address is LEARNED STATE, stored in its own column rather than
  // inside the encrypted blob, so address discovery can update it without
  // rewriting credentials.
  if (row.channel === 'pec' && row.pec_sdi_address) config['sdiAddress'] = row.pec_sdi_address;
  return { adapter, config };
}

/**
 * Persist the address SdI assigned for future submissions.
 *
 * Continuing to use sdi01@ after assignment does not error — delivery is merely
 * "not guaranteed". Silent non-receipt of a tax document is the worst failure
 * available, so this is applied the moment it is detected.
 */
export async function recordAssignedPecAddress(
  db: Db, tenantId: string, address: string,
): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    // RLS already scopes this to the tenant, so $1 is the address alone —
    // passing an unused tenantId produced "could not determine data type of $1".
    await tx.query(
      `UPDATE channel_credentials
          SET pec_sdi_address = $1, pec_address_source = 'assigned',
              pec_address_assigned_at = now()
        WHERE channel = 'pec'`,
      [address],
    );
    // Use the shared audit helper: a hand-written INSERT skips the hash chain,
    // silently breaking tamper detection for every later row.
    await audit(tx, {
      tenantId, actor: 'channel:pec', action: 'pec.address_assigned',
      resourceType: 'channel', resourceId: 'pec', detail: { address },
    });
  });
}
