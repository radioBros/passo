import { pino } from 'pino';

/**
 * Structured logging with mandatory redaction.
 *
 * Secrets must never reach a log line at ANY level. The redact list covers both
 * the field names we control and the header/env shapes that carry credentials.
 */
export const REDACT = [
  'req.headers.authorization', 'req.headers.cookie', 'headers.authorization',
  'apiKey', 'api_key', 'key', 'keyHash', 'secret', 'secretEncrypted', 'password',
  'PASSO_ADMIN_KEY', 'DATABASE_URL', 'RABBITMQ_URL',
  '*.password', '*.secret', '*.apiKey', '*.token',
  'config.password', 'credentials', 'smtpPassword', 'pecPassword',
  'ALERT_SMTP_PASSWORD', 'OPERATOR_ALERT_WEBHOOK_SECRET', 'webhookSecret', '*.webhookSecret',
];

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  redact: { paths: REDACT, censor: '[redacted]' },
  base: { service: 'passo' },
});

export type Logger = typeof logger;
