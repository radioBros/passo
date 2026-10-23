/**
 * Every alert PASSO can raise, with what it means and what to do about it.
 *
 * The remedy is the point. "ERR_CHANNEL_CREDIT on submission 0c86…" tells an
 * accountant nothing; "your OpenAPI.it wallet is empty — invoices are waiting,
 * top it up" tells them what to do. Text is plain, in English, and contains no
 * invoice data: the operator destination receives every tenant's alerts.
 */
export type AlertSeverity = 'warning' | 'critical';

export interface AlertKind {
  severity: AlertSeverity;
  /** Tenant alerts go to the tenant AND the operator; system alerts to the operator only. */
  scope: 'tenant' | 'system';
  title: string;
  impact: string;
  remedy: string;
}

export const ALERT_KINDS = {
  'channel.credit_exhausted': {
    severity: 'critical', scope: 'tenant',
    title: 'SdI channel account is out of credit',
    impact: 'Invoices are NOT being sent. They are kept queued and retried, and go out once credit is available — but if retries run out first they are marked failed.',
    remedy: 'Top up the vendor account (for OpenAPI.it: the wallet in console.openapi.com). No action is needed in PASSO afterwards.',
  },
  'channel.setup_required': {
    severity: 'critical', scope: 'tenant',
    title: 'SdI channel account is not set up for this seller',
    impact: 'Every invoice for this seller is refused by the vendor and marked failed.',
    remedy: 'For OpenAPI.it: create a business registry for the seller\'s VAT number (POST /business_registry_configurations), and make "requestSigning" in PASSO match its "apply_signature". Then retry the failed invoices.',
  },
  'channel.auth_failed': {
    severity: 'critical', scope: 'tenant',
    title: 'SdI channel rejected PASSO\'s credentials',
    impact: 'No invoice can be sent until the credentials are fixed. Affected invoices are marked failed.',
    remedy: 'Issue a new token or key at the vendor and update the channel: PUT /api/v1/admin/tenants/{tenantId}/channels/{channel}. Then retry the failed invoices.',
  },
  'channel.unreadable': {
    severity: 'critical', scope: 'tenant',
    title: 'SdI channel configuration could not be loaded',
    impact: 'Invoices cannot be sent. They are retried, then marked failed.',
    remedy: 'Usually an encryption-key change: check PASSO_ENCRYPTION_KEY_* still holds the key the channel was saved with, or configure the channel again.',
  },
  'channel.unavailable': {
    severity: 'warning', scope: 'tenant',
    title: 'SdI channel is unreachable or failing',
    impact: 'Invoices are queued and retried automatically.',
    remedy: 'Usually a vendor outage — nothing to do unless it persists. Check the vendor\'s status page.',
  },
  'submission.outcome_unknown': {
    severity: 'critical', scope: 'tenant',
    title: 'An invoice may or may not have reached the vendor',
    impact: 'The vendor did not answer in time. PASSO does NOT resend it automatically: if the vendor did receive it, a resend would duplicate the invoice at SdI.',
    remedy: 'Look the invoice up in the vendor console. If it is not there, retry it: POST /api/v1/invoices/{submissionId}/retry. If it is there, do nothing — the receipt will arrive.',
  },
  'submission.failed': {
    severity: 'warning', scope: 'tenant',
    title: 'Invoices failed and were not sent to SdI',
    impact: 'These invoices never reached SdI. They are NOT issued.',
    remedy: 'Fix the cause given in the detail, then retry each one: POST /api/v1/invoices/{submissionId}/retry. The CRM also receives a submission.failed webhook per invoice.',
  },
  'pec.poll_failed': {
    severity: 'critical', scope: 'tenant',
    title: 'PEC mailbox cannot be read',
    impact: 'SdI receipts are NOT being collected. They are safe in the mailbox and are read once access works again.',
    remedy: 'Usually a changed mailbox password or an expired PEC subscription: update the channel (PUT /api/v1/admin/tenants/{tenantId}/channels/pec).',
  },
  'receipt.quarantined': {
    severity: 'warning', scope: 'tenant',
    title: 'A receipt could not be processed and was quarantined',
    impact: 'One SdI message was kept aside instead of being applied to an invoice. Nothing was discarded.',
    remedy: 'Review it: GET /api/v1/admin/quarantine.',
  },
  'webhook.delivery_failed': {
    severity: 'warning', scope: 'tenant',
    title: 'The CRM webhook endpoint is failing',
    impact: 'Events could not be delivered after every retry. Nothing is lost: GET /api/v1/pending lists everything not yet acknowledged.',
    remedy: 'Check the endpoint is up and answers 2xx, then reconcile via GET /api/v1/pending.',
  },
  'system.outbox_abandoned': {
    severity: 'critical', scope: 'system',
    title: 'Messages could not be handed to the queue and were abandoned',
    impact: 'Some work (an invoice transmission or an event) was not started. The rows are kept, not deleted.',
    remedy: 'Check RabbitMQ health and bindings, then inspect: SELECT * FROM outbox WHERE abandoned_at IS NOT NULL.',
  },
  'system.audit_chain_broken': {
    severity: 'critical', scope: 'system',
    title: 'The audit log hash chain is broken',
    impact: 'An audit entry was altered or removed outside PASSO. Treat as a possible security incident.',
    remedy: 'Run GET /api/v1/admin/tenants/{tenantId}/audit/verify, preserve the database, and investigate who had direct database access.',
  },
  'system.ingress_stalled': {
    severity: 'critical', scope: 'system',
    title: 'Receipts have stopped arriving',
    impact: 'Invoices are waiting for SdI receipts that are not being collected.',
    remedy: 'Check the worker is running and its logs; for PEC, that the mailbox is reachable.',
  },
  'alert.test': {
    severity: 'warning', scope: 'tenant',
    title: 'PASSO test alert',
    impact: 'None — this is a test.',
    remedy: 'If you received this, alert delivery works.',
  },
} as const satisfies Record<string, AlertKind>;

export type AlertKindName = keyof typeof ALERT_KINDS;

/** Map a channel error code to the alert it should raise, if any. */
export function alertForChannelCode(code: string | null | undefined): AlertKindName | null {
  switch (code) {
    case 'ERR_CHANNEL_CREDIT': return 'channel.credit_exhausted';
    case 'ERR_CHANNEL_SETUP': return 'channel.setup_required';
    case 'ERR_CHANNEL_AUTH': return 'channel.auth_failed';
    case 'ERR_CHANNEL_NOT_CONFIGURED': return 'channel.unreadable';
    case 'ERR_CHANNEL_UNAVAILABLE':
    case 'ERR_CHANNEL_TIMEOUT': return 'channel.unavailable';
    default: return null;
  }
}

/** Channel alerts a successful transmission proves are over. */
export const RESOLVED_BY_SUCCESSFUL_SEND: readonly AlertKindName[] = [
  'channel.credit_exhausted', 'channel.setup_required', 'channel.auth_failed',
  'channel.unreadable', 'channel.unavailable',
];
