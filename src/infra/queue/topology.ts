/**
 * RabbitMQ topology.
 *
 * Postgres is the durability boundary (transactional outbox); RabbitMQ is
 * transport, routing, delayed retry and dead-lettering. Nothing that matters
 * survives only in the broker.
 */
export const EXCHANGES = {
  invoices: 'passo.invoices',
  retry: 'passo.retry',
  dlx: 'passo.dlx',
  webhooks: 'passo.webhooks',
} as const;

export const QUEUES = {
  transform: 'q.transform',
  generate: 'q.generate-xml',
  sign: 'q.sign',
  submit: 'q.submit-sdi',
  pecParse: 'q.pec-parse',
  notify: 'q.notification',
  webhook: 'q.dispatch-webhook',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Per-job-type retry. NEVER uniform — see notification_types_spec. */
export interface RetryPolicy { maxAttempts: number; baseMs: number; maxMs: number }

export const RETRY: Record<QueueName, RetryPolicy> = {
  // Deterministic stages: a failure is a data defect, not a transient fault.
  [QUEUES.transform]: { maxAttempts: 1, baseMs: 0, maxMs: 0 },
  [QUEUES.generate]:  { maxAttempts: 1, baseMs: 0, maxMs: 0 },
  [QUEUES.sign]:      { maxAttempts: 3, baseMs: 2_000, maxMs: 32_000 },
  [QUEUES.submit]:    { maxAttempts: 5, baseMs: 5_000, maxMs: 300_000 },
  [QUEUES.pecParse]:  { maxAttempts: 3, baseMs: 5_000, maxMs: 60_000 },
  [QUEUES.notify]:    { maxAttempts: 3, baseMs: 1_000, maxMs: 30_000 },
  [QUEUES.webhook]:   { maxAttempts: 6, baseMs: 1_000, maxMs: 3_600_000 },
};

export function backoffMs(q: QueueName, attempt: number): number {
  const p = RETRY[q];
  const raw = Math.min(p.baseMs * 2 ** Math.max(0, attempt - 1), p.maxMs);
  return Math.round(raw * (0.75 + Math.random() * 0.5));   // jitter
}

export const dlqName = (q: QueueName): string => `dlq.${q.replace(/^q\./, '')}`;
