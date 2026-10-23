import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Db } from '../infra/db/pool.ts';
import { withTenant, withQuarantineRole, audit, type Tx } from '../infra/db/pool.ts';
import { retrySubmission } from '../domain/submission/service.ts';
import { canRetry, type State } from '../domain/submission/state.ts';
import { ApiError } from '../shared/errors/catalog.ts';
import type { Logger } from '../shared/logger.ts';
import { asString, asNumber } from '../shared/util/coerce.ts';

/**
 * MCP server — lets an LLM inspect and operate ONE tenant.
 *
 * The MCP key is tenant-scoped, so an LLM sees exactly one tenant's data. That
 * is the single most important property here: an LLM with cross-tenant reach
 * would be a data-exfiltration path with a natural-language interface.
 *
 * Read-mostly. The one write is retrySubmission, which is itself guarded: an
 * NS-rejected submission CANNOT be retried, because doing so submits a
 * duplicate to the tax authority. The tool refuses and explains.
 */

export interface McpDeps {
  db: Db; tenantId: string; log: Logger;
  /**
   * Scopes from the resolving MCP key. Absent means the process-level fallback
   * (PASSO_MCP_TENANT_ID), where the operator IS the authority — so every tool
   * is available, matching the behaviour before keys existed.
   */
  scopes?: string[];
}

/** Which scope each tool needs (MCP-008). */
const TOOL_SCOPE: Record<string, string> = {
  list_submissions: 'invoices:read',
  get_submission: 'invoices:read',
  list_pending: 'invoices:read',
  analyse_failures: 'invoices:read',
  list_webhooks: 'webhooks:read',
  list_dlq_items: 'invoices:read',
  get_api_key_status: 'keys:read',
  // The ONLY write. Even so it is guarded by the state machine, which refuses
  // an NS or MC retry outright.
  retry_submission: 'invoices:write',
};

/** Bound every call, so a slow query cannot hang an assistant indefinitely. */
const CALL_TIMEOUT_MS = 15_000;

/**
 * Per-session limits (MCP-024).
 *
 * A model in a loop is the realistic failure here — not malice, but a retry
 * that never terminates. Uncapped it would exhaust the connection pool that
 * invoice submission depends on, so an assistant misbehaving would take down
 * the thing that actually matters.
 *
 * In-process because an MCP session IS a process: there is nothing to share
 * state with, and reaching for Redis would add a dependency for no gain.
 */
const MAX_CALLS_PER_MINUTE = 100;
const MAX_CONCURRENT_CALLS = 5;

const withTimeout = async <T>(p: Promise<T>, name: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`MCP tool "${name}" exceeded ${CALL_TIMEOUT_MS}ms and was aborted`)),
          CALL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Last-line output redaction (MCP-026).
 *
 * Every query here is written to avoid secrets, but the consumer is a language
 * model that may echo whatever it receives into a transcript. A field named
 * like a secret is stripped regardless of how it got into the result.
 */
const SECRET_KEY = /(secret|password|key_hash|token|credential|ciphertext|iv|tag)/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

/**
 * Every tool this server can expose. Filtered per key by scope at list time.
 */
const ALL_TOOLS: Array<{ name: string; description: string; inputSchema: unknown }> = [
  {
    name: 'list_webhooks',
    description:
      'List this tenant webhook subscriptions: callback URL, subscribed events, active ' +
      'flag and recent failure count. The signing secret is NEVER returned.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_dlq_items',
    description:
      'List quarantined receipts — notifications whose owning submission could not be ' +
      'determined. Metadata only; the raw payload is not exposed. Replay is an operator ' +
      'action and is deliberately NOT available here.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', default: 20 } },
    },
  },
  {
    name: 'get_api_key_status',
    description:
      'API key metadata for this tenant: prefix, name, scopes, status, expiry and ' +
      'last use. Never returns key material or a hash.',
    inputSchema: { type: 'object', properties: {} },
  },
      {
        name: 'list_submissions',
        description: 'List invoice submissions for this tenant, optionally filtered by state.',
        inputSchema: {
          type: 'object',
          properties: {
            state: { type: 'string', description: 'queued|transmitted|delivered|rejected|failed|awaiting_delivery' },
            limit: { type: 'number', default: 20 },
          },
        },
      },
      {
        name: 'get_submission',
        description: 'Full status and notification history for one submission.',
        inputSchema: {
          type: 'object',
          properties: { submissionId: { type: 'string' } },
          required: ['submissionId'],
        },
      },
      {
        name: 'retry_submission',
        description:
          'Retry a transient failure. REFUSES an NS-rejected submission: NS is terminal, ' +
          'the invoice is legally not issued, and a corrected invoice must be submitted anew.',
        inputSchema: {
          type: 'object',
          properties: { submissionId: { type: 'string' } },
          required: ['submissionId'],
        },
      },
      {
        name: 'list_pending',
        description: 'Submissions awaiting a terminal receipt or carrying unacknowledged receipts.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'analyse_failures',
        description: 'Group recent rejections by SdI error code to show what is failing and why.',
        inputSchema: { type: 'object', properties: { days: { type: 'number', default: 7 } } },
      },
  ];

export function createMcpServer(d: McpDeps): Server {
  const server = new Server(
    { name: 'passo', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    // A tool the key cannot call is not listed: offering it would have the
    // model plan around a capability it does not have.
    tools: ALL_TOOLS.filter((t) => permits(t.name)),
  }));


  let inFlight = 0;
  let windowStart = Date.now();
  let callsThisWindow = 0;

  /** Returns a refusal reason, or null when the call may proceed. */
  const limitCheck = (): string | null => {
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; callsThisWindow = 0; }
    if (callsThisWindow >= MAX_CALLS_PER_MINUTE) {
      return `this session has made ${MAX_CALLS_PER_MINUTE} calls in the last minute, ` +
        'which is the limit. Wait for the window to reset.';
    }
    if (inFlight >= MAX_CONCURRENT_CALLS) {
      return `${MAX_CONCURRENT_CALLS} calls are already in flight, which is the limit. ` +
        'Await the outstanding calls before making more.';
    }
    callsThisWindow++;
    return null;
  };

  /** A tool is available only if the key's scopes permit it. */
  const permits = (tool: string): boolean => {
    if (!d.scopes) return true;                 // process-level fallback
    const need = TOOL_SCOPE[tool];
    return !need || d.scopes.includes(need);
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const a = args;
    // Redacted on the way out: the consumer is a model that may echo results.
    const text = (v: unknown) =>
      ({ content: [{ type: 'text' as const, text: JSON.stringify(redact(v), null, 2) }] });

    /**
     * Refused, not silently empty. A model given an empty result concludes
     * "there is nothing" and reports that to a user; being told it lacks the
     * scope is the only answer it can act on.
     */
    if (!permits(name)) {
      return text({
        refused: true, reason: 'ERR_AUTH_SCOPE', tool: name,
        requiredScope: TOOL_SCOPE[name],
        explanation:
          `This MCP key does not hold "${TOOL_SCOPE[name]}", so the tool cannot run. ` +
          'Ask the operator for a key with that scope — this is not an empty result.',
      });
    }

    /**
     * Refused with an explanation the model can act on. A bare error would
     * have it retry immediately, which is how the loop started.
     */
    const limited = limitCheck();
    if (limited) {
      return text({
        refused: true, reason: 'ERR_RATE_LIMITED', tool: name,
        explanation: limited,
      });
    }

    inFlight++;
    try {
      return await withTimeout(handleTool(name, a, text), name);
    } finally {
      inFlight--;
    }
  });

  async function handleTool(
    name: string, a: Record<string, unknown>,
    text: (v: unknown) => { content: Array<{ type: 'text'; text: string }> },
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    switch (name) {
      case 'list_submissions': {
        const rows = await withTenant(d.db, d.tenantId, (tx) => tx.query(
          `SELECT s.id, s.state, s.progressivo_invio, s.channel, s.created_at, i.invoice_number
             FROM sdi_submissions s JOIN invoices i ON i.id = s.invoice_id
            WHERE ($1::text IS NULL OR s.state = $1)
            ORDER BY s.created_at DESC LIMIT $2`,
          [a['state'] ?? null, Number(a['limit'] ?? 20)],
        ));
        return text(rows.rows);
      }
      case 'get_submission': {
        const r = await withTenant(d.db, d.tenantId, async (tx) => {
          const s = await tx.query(
            `SELECT s.id, s.state, s.progressivo_invio, s.channel, s.identificativo_sdi,
                    s.purged_at, s.terminal_at, i.invoice_number
               FROM sdi_submissions s JOIN invoices i ON i.id = s.invoice_id
              WHERE s.id = $1`, [a['submissionId']]);
          const n = await tx.query(
            `SELECT type, received_at, parsed, acknowledged_at FROM notifications
              WHERE submission_id = $1 ORDER BY received_at`, [a['submissionId']]);
          return { submission: s.rows[0] ?? null, notifications: n.rows };
        });
        return text(r);
      }
      case 'retry_submission': {
        const id = asString(a['submissionId'], 'submissionId');
        const cur = await withTenant(d.db, d.tenantId, (tx) => tx.query<{ state: State }>(
          'SELECT state FROM sdi_submissions WHERE id=$1', [id]));
        const st = cur.rows[0]?.state;
        if (!st) return text({ error: 'submission not found' });
        const guard = canRetry(st);
        if (!guard.ok) {
          // Explain rather than fail silently — this is the mistake integrators
          // and LLMs make most often.
          return text({
            refused: true, reason: guard.reason, state: st,
            explanation: guard.reason === 'ERR_CONFLICT_NS_RETRY'
              ? 'NS is terminal. The invoice is legally NOT issued. Correct the invoice and submit it as a NEW invoice — PASSO allocates a new ProgressivoInvio. Retrying would send a duplicate to the tax authority.'
              : guard.reason === 'ERR_CONFLICT_MC_RETRY'
                ? 'MC means SdI is still attempting delivery. The invoice IS legally issued. Resubmitting would duplicate it.'
                : 'The submission has already reached a terminal state.',
          });
        }
        try {
          await retrySubmission(d.db, d.tenantId, id);
          await withTenant(d.db, d.tenantId, (tx) => audit(tx, {
            tenantId: d.tenantId, actor: 'mcp', action: 'submission.retry',
            resourceType: 'submission', resourceId: id,
          }));
          return text({ retried: true, submissionId: id });
        } catch (e) {
          return text({ error: e instanceof ApiError ? e.code : String(e) });
        }
      }
      case 'list_pending': {
        const rows = await withTenant(d.db, d.tenantId, (tx) => tx.query(
          `SELECT c.submission_id, c.crm_invoice_ref, c.status,
                  count(n.id) FILTER (WHERE n.acknowledged_at IS NULL)::int AS unacknowledged
             FROM correlation_records c
             LEFT JOIN notifications n ON n.submission_id = c.submission_id
            GROUP BY c.submission_id, c.crm_invoice_ref, c.status, c.created_at
           HAVING count(n.id) FILTER (WHERE n.acknowledged_at IS NULL) > 0
            ORDER BY c.created_at DESC LIMIT 50`));
        return text(rows.rows);
      }
      case 'analyse_failures': {
        const rows = await withTenant(d.db, d.tenantId, (tx) => tx.query(
          `SELECT e->>'codice' AS code, e->>'descrizione' AS description, count(*)::int AS occurrences
             FROM notifications n, jsonb_array_elements(n.parsed->'errors') e
            WHERE n.type = 'NS' AND n.received_at > now() - ($1 || ' days')::interval
            GROUP BY 1,2 ORDER BY occurrences DESC`,
          [String(asNumber(a['days'], 'days', 7))]));
        return text({ rejections: rows.rows });
      }
      case 'list_webhooks': {
        const rows = await withTenant(d.db, d.tenantId, (tx) => tx.query(
          `SELECT id, url, events, active, disabled_reason, consecutive_failures,
                  secret_prefix, created_at
             FROM webhooks ORDER BY created_at DESC`));
        // secret_encrypted is never selected; redact() is the second line.
        return text(rows.rows);
      }

      case 'list_dlq_items': {
        const limit = Math.min(asNumber(a['limit'], 'limit', 20), 100);
        // Metadata view only — the raw fiscal payload of a receipt whose tenant
        // is unknown must not reach a language model.
        const rows = await withQuarantineRole(d.db, (tx) => tx.query(
          `SELECT id, reason, type, identificativo_sdi, channel, created_at
             FROM quarantine_index WHERE resolved_at IS NULL
            ORDER BY created_at DESC LIMIT $1`, [limit]));
        return text({
          items: rows.rows,
          note:
            'Replay is an operator action, not an assistant action — it is not exposed here. ' +
            'Use the passo-cli or the Admin API.',
        });
      }

      case 'get_api_key_status': {
        const rows = await withTenant(d.db, d.tenantId, (tx) => tx.query<{
          expires_at: Date | null;
        }>(
          `SELECT id, key_prefix, name, scopes, status, expires_at, last_used_at, created_at
             FROM api_keys ORDER BY created_at DESC`));
        return text(rows.rows.map((k) => ({
          ...k,
          daysRemaining: k.expires_at
            ? Math.ceil((new Date(k.expires_at).getTime() - Date.now()) / 86_400_000)
            : null,
        })));
      }

      default:
        return text({ error: `unknown tool "${name}"` });
    }
  }

  /**
   * Named prompts (MCP-020 / MCP-022).
   *
   * These exist because the model needs the DOMAIN rules stated, not just the
   * data. Left to itself it will report an NS as "failed, will retry" — which
   * is exactly backwards, and the advice a user would then act on.
   */
  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [
      {
        name: 'invoice_status_report',
        description:
          'Summarise submissions by status for a period, calling out rejections with their ' +
          'remediation. Encodes the NS/MC rules the model must not get wrong.',
        arguments: [
          { name: 'days', description: 'How many days back to cover (default 7)', required: false },
        ],
      },
      {
        name: 'key_rotation_reminder',
        description:
          'Report API keys nearing expiry and recommend rotation through the operator admin ' +
          'path. Never attempts the rotation itself.',
        arguments: [],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, (req) => {
    const name = req.params.name;
    if (name === 'invoice_status_report') {
      const days = Number(req.params.arguments?.['days'] ?? 7);
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Produce a status report for the last ${days} days.`,
              '',
              'Use list_submissions and analyse_failures. Group by status and state the',
              'counts plainly.',
              '',
              'THREE RULES YOU MUST FOLLOW, because getting them wrong gives the reader',
              'advice that costs them money:',
              '',
              '1. An NS (state `rejected`) is TERMINAL. The invoice is legally NOT issued.',
              '   Never describe it as "failed, will retry" or suggest retrying — the retry',
              '   is refused, and a resubmission of the same document fails identically.',
              '   The correct advice is: fix the errors, issue a NEW invoice.',
              '2. An MC (state `awaiting_delivery`) is NOT a failure. The invoice IS legally',
              '   issued and SdI is still delivering. Do not list it as a problem and never',
              '   suggest resubmitting — that duplicates a legally issued document.',
              '3. For each rejection, quote the SdI error code AND its remedy from the',
              '   catalogue. A bare code is not actionable.',
              '',
              'If you cannot retrieve something because this key lacks the scope, say so',
              'explicitly rather than reporting zero.',
            ].join('\n'),
          },
        }],
      };
    }
    if (name === 'key_rotation_reminder') {
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              'Call get_api_key_status and report any key expiring within 30 days, with its',
              'name, prefix and days remaining.',
              '',
              'Recommend rotation through the operator\'s own admin path. You cannot rotate',
              'a key yourself and must not imply that you can — key material never passes',
              'through this interface, by design.',
              '',
              'If a key has already expired, say so separately: it is no longer',
              'authenticating and something is probably already broken.',
            ].join('\n'),
          },
        }],
      };
    }
    throw new Error(`Unknown prompt "${name}". Available: invoice_status_report, key_rotation_reminder`);
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      { uri: 'passo://submissions', name: 'Submissions', mimeType: 'application/json',
        description: 'Recent submissions for this tenant' },
      { uri: 'passo://audit-log', name: 'Audit log', mimeType: 'application/json',
        description: 'Recent audit entries for this tenant' },
    ],
  }));

  /**
   * Resource URIs are matched against an ALLOWLIST, never by substring.
   *
   * A substring test (`uri.includes('audit')`) has two failure modes that both
   * matter here: an unknown URI silently falls through to whichever branch is
   * last — returning data the caller never asked for — and a crafted URI like
   * `passo://submissions#audit` selects a branch by coincidence. An LLM is the
   * caller, so unrecognised input is expected rather than exceptional; it must
   * produce an error, not a plausible-looking wrong answer.
   */
  const RESOURCES: Record<string, (tx: Tx) => Promise<{ rows: unknown[] }>> = {
    'passo://submissions': (tx) => tx.query(
      `SELECT s.id, s.state, i.invoice_number FROM sdi_submissions s
         JOIN invoices i ON i.id = s.invoice_id ORDER BY s.created_at DESC LIMIT 100`),
    /**
     * The invoice as PASSO holds it — summary fields only.
     *
     * Deliberately NOT the raw XML: it carries counterparty detail, attachments
     * and signature material, and the consumer is a model that may echo
     * whatever it receives into a transcript.
     */
    'passo://invoices': (tx) => tx.query(
      `SELECT i.id, i.invoice_number, i.document_type, i.issue_date, i.currency,
              s.state, s.progressivo_invio, s.identificativo_sdi
         FROM invoices i LEFT JOIN sdi_submissions s ON s.invoice_id = i.id
        ORDER BY i.created_at DESC LIMIT 100`),
    'passo://audit-log': (tx) => tx.query(
      // A BOUNDED window: the audit log is forensic material, and handing a
      // model an unbounded history invites it into a much larger surface than
      // the question being asked.
      `SELECT actor, action, resource_type, resource_id, created_at
         FROM audit_log
        WHERE created_at > now() - interval '7 days'
        ORDER BY id DESC LIMIT 100`),
  };

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const query = RESOURCES[uri];
    if (!query) {
      throw new Error(
        `Unknown resource "${uri}". Available: ${Object.keys(RESOURCES).join(', ')}`);
    }
    const rows = await withTenant(d.db, d.tenantId, (tx) => query(tx));
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(rows.rows, null, 2) }] };
  });

  return server;
}

export async function startMcpStdio(d: McpDeps): Promise<void> {
  const server = createMcpServer(d);
  await server.connect(new StdioServerTransport());
  d.log.info({ tenantId: d.tenantId }, 'MCP server listening on stdio');
}
