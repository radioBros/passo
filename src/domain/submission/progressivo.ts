import type { Tx } from '../../infra/db/pool.ts';

/**
 * ProgressivoInvio allocation.
 *
 * String10Type: 1..10 basic-Latin characters, UNIQUE per transmitter.
 * (Earlier drafts said 5 — the XSD says 10.)
 *
 * An NS retry MUST allocate a NEW value. Reusing the rejected one yields a
 * duplicate rejection, because SdI already saw that progressivo.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';   // base36, uppercase-safe

function encode(n: number, width = 5): string {
  let out = '';
  let v = n;
  while (v > 0) { out = ALPHABET[v % 36]! + out; v = Math.floor(v / 36); }
  return out.padStart(width, '0');
}

/**
 * Allocate atomically from a monotonic per-transmitter counter.
 *
 * NOT derived from COUNT(*) of existing rows: an NS retry burns a value and
 * leaves a gap, so count+1 collides with a row that already exists. The
 * counter only moves forward, so gaps are harmless.
 *
 * The UPDATE ... RETURNING takes a row lock, which serialises concurrent
 * allocators for the same transmitter without an explicit advisory lock.
 */
export async function allocateProgressivo(tx: Tx, transmitterId: string): Promise<string> {
  // Ensure the counter row exists, then claim by incrementing and returning the
  // NEW value. One statement, one row lock, no read-then-write race.
  await tx.query(
    `INSERT INTO progressivo_counters (transmitter_id, next_value)
     VALUES ($1, 0) ON CONFLICT (transmitter_id) DO NOTHING`,
    [transmitterId],
  );
  const r = await tx.query<{ next_value: string }>(
    `UPDATE progressivo_counters
        SET next_value = next_value + 1, updated_at = now()
      WHERE transmitter_id = $1
      RETURNING next_value`,
    [transmitterId],
  );
  return encode(Number(r.rows[0]!.next_value));
}

export const isValidProgressivo = (s: string): boolean =>
  s.length >= 1 && s.length <= 10 && /^[\x20-\x7E]+$/.test(s);
