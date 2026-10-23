#!/usr/bin/env node --experimental-strip-types
// Dev helper: configure a tenant's SDI channel with encrypted credentials.
//   node --experimental-strip-types scripts/seed-channel.mjs <tenantId> [channel] [configJson]
import { EnvKeyProvider, encrypt } from '../src/infra/crypto/keys.ts';
import pg from 'pg';

const [, , tenantId, channel = 'mock', configJson = '{}'] = process.argv;
if (!tenantId) { console.error('usage: seed-channel.mjs <tenantId> [channel] [configJson]'); process.exit(1); }

const keys = new EnvKeyProvider();
const e = encrypt(keys, configJson, tenantId, 'channel_config');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query('DELETE FROM channel_credentials WHERE tenant_id=$1 AND channel=$2', [tenantId, channel]);
await c.query(
  `INSERT INTO channel_credentials (tenant_id,channel,config_encrypted,config_key_version,config_iv,config_tag)
   VALUES ($1,$2,$3,$4,$5,$6)`,
  [tenantId, channel, e.ciphertext, e.keyVersion, e.iv, e.tag]);
await c.end();
console.log(`channel "${channel}" configured for tenant ${tenantId}`);
