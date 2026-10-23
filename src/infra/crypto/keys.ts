import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/**
 * Encryption at rest — AES-256-GCM with a pluggable key provider.
 *
 * Self-hosted default is env vars. Requiring Vault or a cloud KMS to run PASSO
 * would contradict the self-hosted premise; the operator already controls the
 * host, the process and the database.
 *
 * Documented limitation: with the env provider, anyone who can read the process
 * environment or a memory dump can read the key. Operators handling
 * higher-sensitivity data should use a Vault/KMS provider behind this interface.
 */

export interface KeyMaterial { version: string; key: Buffer }

export interface KeyProvider {
  getActiveKey(): KeyMaterial;
  getKeyByVersion(version: string): KeyMaterial;
  listVersions(): string[];
}

export class KeyError extends Error {}

/** Reads PASSO_ENCRYPTION_KEY_<VERSION> (base64, 32 bytes) + PASSO_ENCRYPTION_KEY_ACTIVE. */
export class EnvKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();
  private readonly active: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    for (const [k, v] of Object.entries(env)) {
      const m = /^PASSO_ENCRYPTION_KEY_([A-Za-z0-9]+)$/.exec(k);
      if (!m || m[1] === 'ACTIVE' || !v) continue;
      const buf = Buffer.from(v, 'base64');
      if (buf.length !== 32) {
        throw new KeyError(`${k}: expected 32 bytes base64, got ${buf.length}`);
      }
      this.keys.set(m[1]!.toLowerCase(), buf);
    }
    const file = env['PASSO_KEY_FILE'];
    if (file) {
      const mode = statSync(file).mode & 0o077;
      if (mode !== 0) throw new KeyError(`${file}: permissions must be 0600 or stricter`);
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const [ver, b64] = line.trim().split('=');
        if (!ver || !b64) continue;
        const buf = Buffer.from(b64, 'base64');
        if (buf.length !== 32) throw new KeyError(`${file}: key ${ver} is not 32 bytes`);
        this.keys.set(ver.toLowerCase(), buf);
      }
    }
    const active = (env['PASSO_ENCRYPTION_KEY_ACTIVE'] ?? '').toLowerCase();
    if (!active) {
      throw new KeyError(
        'PASSO_ENCRYPTION_KEY_ACTIVE is not set — refusing to start rather than store plaintext',
      );
    }
    if (!this.keys.has(active)) {
      throw new KeyError(`active key version "${active}" has no matching PASSO_ENCRYPTION_KEY_${active.toUpperCase()}`);
    }
    this.active = active;
  }

  getActiveKey(): KeyMaterial {
    return { version: this.active, key: this.keys.get(this.active)! };
  }

  getKeyByVersion(version: string): KeyMaterial {
    const key = this.keys.get(version.toLowerCase());
    // Retired keys stay resolvable so historical rows remain decryptable.
    if (!key) throw new KeyError(`unknown key version "${version}" — cannot decrypt`);
    return { version: version.toLowerCase(), key };
  }

  listVersions(): string[] { return [...this.keys.keys()]; }
}

export interface Encrypted {
  ciphertext: Buffer; iv: Buffer; tag: Buffer; keyVersion: string;
}

/**
 * AAD binds the ciphertext to its tenant and column, so a value cannot be
 * transplanted between rows or tables even by someone with database write access.
 */
function aad(tenantId: string, column: string): Buffer {
  return Buffer.from(`${tenantId}:${column}`, 'utf8');
}

export function encrypt(
  provider: KeyProvider, plaintext: Buffer | string, tenantId: string, column: string,
): Encrypted {
  const { version, key } = provider.getActiveKey();
  const iv = randomBytes(12);                       // 96-bit, never reused
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(tenantId, column));
  const ciphertext = Buffer.concat([
    c.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    c.final(),
  ]);
  return { ciphertext, iv, tag: c.getAuthTag(), keyVersion: version };
}

export function decrypt(
  provider: KeyProvider, e: Encrypted, tenantId: string, column: string,
): Buffer {
  const { key } = provider.getKeyByVersion(e.keyVersion);
  const d = createDecipheriv('aes-256-gcm', key, e.iv);
  d.setAAD(aad(tenantId, column));
  d.setAuthTag(e.tag);
  return Buffer.concat([d.update(e.ciphertext), d.final()]);
}

export const decryptString = (
  p: KeyProvider, e: Encrypted, t: string, c: string,
): string => decrypt(p, e, t, c).toString('utf8');
