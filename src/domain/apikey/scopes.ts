/**
 * The API-key scope catalogue (KEY-014).
 *
 * A closed set, because scopes are the only thing standing between a stolen
 * read-only key and the ability to redirect webhooks or mint new credentials.
 * An open-ended string would let a typo (`webhook:write`) silently grant
 * nothing while looking correct in the database.
 *
 * Scopes are `resource:action`. `read` never implies `write`, and `write` never
 * implies `read` — a key that may register a webhook does not thereby gain the
 * right to list existing ones, because the two answer different questions about
 * what the holder is trusted with.
 */
export const SCOPES = [
  'invoices:read',
  'invoices:write',
  'webhooks:read',
  'webhooks:write',
  'transformations:read',
  'transformations:write',
  'keys:read',
  'keys:write',
] as const;

export type Scope = (typeof SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);
export const isScope = (v: string): v is Scope => SCOPE_SET.has(v);

/** What each scope permits, for the key-creation surface and the docs. */
export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  'invoices:read': 'Read submission status, receipts, XML and rendered output',
  'invoices:write': 'Submit invoices, retry, and acknowledge receipts',
  'webhooks:read': 'List subscriptions and read delivery history',
  'webhooks:write': 'Create, update, rotate and delete webhook subscriptions',
  'transformations:read': 'List and fetch transformation templates',
  'transformations:write': 'Save, test and delete transformation templates',
  'keys:read': 'List API key metadata (never key material)',
  'keys:write': 'Create, rotate and revoke API keys',
};

/**
 * What a key gets when the caller does not say.
 *
 * Deliberately NOT every scope. A key created without thought should be able to
 * do the ordinary job — submit invoices and watch what happens to them — and
 * nothing that changes the security posture of the tenant. Widening a key is a
 * deliberate act; narrowing one after a leak is not possible.
 */
export const DEFAULT_SCOPES: readonly Scope[] = [
  'invoices:read', 'invoices:write', 'webhooks:read', 'webhooks:write',
  'transformations:read', 'transformations:write',
] as const;

/**
 * An MCP key is read-mostly by default.
 *
 * The holder is a language model. It may inspect and it may retry a submission
 * — a bounded, auditable action the state machine already refuses when it would
 * be unsafe — but it may not mint credentials or redirect a webhook.
 */
export const MCP_DEFAULT_SCOPES: readonly Scope[] = [
  'invoices:read', 'webhooks:read',
] as const;

/**
 * Validate a requested scope list, naming the valid set on failure.
 *
 * An unknown scope must be refused at creation: stored, it would grant nothing
 * while appearing to grant something, and the resulting 403 arrives much later
 * with no obvious cause.
 */
export function assertValidScopes(scopes: readonly string[]): Scope[] {
  const bad = scopes.filter((s) => !isScope(s));
  if (bad.length > 0) {
    throw new Error(
      `unknown scope(s): ${bad.join(', ')}. Valid scopes: ${SCOPES.join(', ')}`,
    );
  }
  return [...scopes] as Scope[];
}
