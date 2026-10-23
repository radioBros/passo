import { describe, it, expect } from 'vitest';
import { EnvKeyProvider, KeyError, encrypt, decrypt, decryptString } from '../../src/infra/crypto/keys.ts';

const K1 = Buffer.alloc(32, 1).toString('base64');
const K2 = Buffer.alloc(32, 2).toString('base64');
const env = { PASSO_ENCRYPTION_KEY_V1: K1, PASSO_ENCRYPTION_KEY_ACTIVE: 'v1' };
const TENANT = '11111111-1111-1111-1111-111111111111';

describe('key provider', () => {
  it('refuses to start with no active key — never falls back to plaintext', () => {
    expect(() => new EnvKeyProvider({ PASSO_ENCRYPTION_KEY_V1: K1 })).toThrow(KeyError);
  });
  it('rejects a key that is not 32 bytes', () => {
    expect(() => new EnvKeyProvider({
      PASSO_ENCRYPTION_KEY_V1: Buffer.alloc(16).toString('base64'),
      PASSO_ENCRYPTION_KEY_ACTIVE: 'v1',
    })).toThrow(KeyError);
  });
  it('rejects an active version with no matching key', () => {
    expect(() => new EnvKeyProvider({ PASSO_ENCRYPTION_KEY_V1: K1, PASSO_ENCRYPTION_KEY_ACTIVE: 'v9' }))
      .toThrow(KeyError);
  });
});

describe('AES-256-GCM', () => {
  const p = new EnvKeyProvider(env);

  it('round-trips', () => {
    const e = encrypt(p, 'segreto', TENANT, 'payload');
    expect(decryptString(p, e, TENANT, 'payload')).toBe('segreto');
  });

  it('produces a different IV every time', () => {
    const a = encrypt(p, 'x', TENANT, 'c'); const b = encrypt(p, 'x', TENANT, 'c');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('detects tampered ciphertext', () => {
    const e = encrypt(p, 'x', TENANT, 'c');
    e.ciphertext.writeUInt8(e.ciphertext.readUInt8(0) ^ 0xff, 0);
    expect(() => decrypt(p, e, TENANT, 'c')).toThrow();
  });

  it('AAD stops a ciphertext being transplanted to another tenant', () => {
    const e = encrypt(p, 'tenant-a-secret', TENANT, 'payload');
    expect(() => decrypt(p, e, '22222222-2222-2222-2222-222222222222', 'payload')).toThrow();
  });

  it('AAD stops a ciphertext being transplanted to another column', () => {
    const e = encrypt(p, 'x', TENANT, 'payload');
    expect(() => decrypt(p, e, TENANT, 'webhook_secret')).toThrow();
  });

  it('retired key versions stay decryptable after rotation', () => {
    const old = new EnvKeyProvider(env);
    expect(old.getActiveKey().version).toBe('v1');
    const e = encrypt(old, 'legacy', TENANT, 'c');
    const rotated = new EnvKeyProvider({
      PASSO_ENCRYPTION_KEY_V1: K1, PASSO_ENCRYPTION_KEY_V2: K2,
      PASSO_ENCRYPTION_KEY_ACTIVE: 'v2',
    });
    expect(rotated.getActiveKey().version).toBe('v2');
    expect(decryptString(rotated, e, TENANT, 'c')).toBe('legacy');   // v1 row still readable
  });
});
