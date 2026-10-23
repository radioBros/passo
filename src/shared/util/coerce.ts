/**
 * Safe coercion for values arriving as `unknown` from JSON payloads.
 *
 * `String(someObject)` produces "[object Object]" — which, for a value destined
 * for the database or an SdI document, is silent corruption rather than an
 * error. These helpers reject non-scalars instead.
 */
export function asString(v: unknown, field: string): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  throw new TypeError(`${field}: expected a scalar, got ${v === null ? 'null' : typeof v}`);
}

/** Same, but yields undefined rather than throwing when absent. */
export function asOptionalString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return undefined;
}

export function asNumber(v: unknown, field: string, fallback?: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (fallback !== undefined) return fallback;
  throw new TypeError(`${field}: expected a number, got ${typeof v}`);
}
