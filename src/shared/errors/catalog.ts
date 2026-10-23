/**
 * Single source of truth for error codes. Surfaces in API responses, the docs
 * site and MCP tool errors — all generated from here, never hand-copied.
 */
export interface ErrorDef { http: number; message: string; retryable: boolean }

export const ERRORS = {
  ERR_AUTH_MISSING: { http: 401, message: 'Authorization header missing', retryable: false },
  ERR_AUTH_INVALID: { http: 401, message: 'API key is invalid', retryable: false },
  ERR_AUTH_EXPIRED: { http: 401, message: 'API key has expired', retryable: false },
  ERR_AUTH_REVOKED: { http: 401, message: 'API key has been revoked', retryable: false },
  ERR_AUTH_SCOPE: { http: 403, message: 'API key lacks the required scope', retryable: false },
  // 404 not 403: a 403 would confirm the resource exists in another tenant.
  ERR_NOT_FOUND: { http: 404, message: 'Resource not found', retryable: false },
  ERR_GONE: { http: 410, message: 'Resource was purged after reaching a terminal state', retryable: false },

  ERR_SCHEMA_INVALID: { http: 400, message: 'Request body failed schema validation', retryable: false },
  ERR_NATURA_REQUIRED: { http: 400, message: 'Natura is required when vatRate is 0.00', retryable: false },
  ERR_VALIDATION_PEC_REQUIRED: { http: 400, message: 'recipientPec is required when recipientCode is 0000000', retryable: false },
  ERR_XSD_INVALID: { http: 400, message: 'Generated XML failed XSD validation', retryable: false },
  ERR_XSD_UNAVAILABLE: { http: 500, message: 'XSD not bundled — deployment fault', retryable: false },

  ERR_CHANNEL_UNAVAILABLE: { http: 503, message: 'SDI channel unavailable', retryable: true },
  ERR_CHANNEL_TIMEOUT: { http: 504, message: 'SDI channel timed out', retryable: true },
  ERR_CHANNEL_AUTH: { http: 502, message: 'SDI channel rejected our credentials', retryable: false },
  ERR_CHANNEL_REJECTED: { http: 502, message: 'The SDI channel refused the document', retryable: false },
  ERR_CHANNEL_NOT_CONFIGURED: { http: 400, message: 'No SDI channel configured for this tenant', retryable: false },
  // The vendor account is not set up for this seller (e.g. no OpenAPI.it business
  // registry for its fiscal ID, or a signing setting that disagrees with PASSO's).
  ERR_CHANNEL_SETUP: { http: 502, message: 'The SDI channel account is not set up for this seller', retryable: false },
  // The vendor account has no credit left. Retryable: nothing was sent, and the
  // invoice goes through once the account is topped up.
  ERR_CHANNEL_CREDIT: { http: 502, message: 'The SDI channel account has run out of credit', retryable: true },

  ERR_RATE_LIMITED: { http: 429, message: 'Rate limit exceeded', retryable: true },
  ERR_MESSAGE_TOO_LARGE: { http: 413, message: "Message exceeds SdI's 30MB hard limit", retryable: false },
  ERR_VALIDATION_SIGNATURE_REQUIRED: { http: 400, message: 'B2G requires a signature path: configure a signing channel or supply a signed .p7m', retryable: false },
  ERR_RENDER_FAILED: { http: 422, message: 'The document could not be rendered', retryable: false },
  ERR_TRANSFORM_FAILED: { http: 400, message: 'The named transformation could not map this payload', retryable: false },
  ERR_PAYLOAD_TOO_LARGE: { http: 413, message: 'Request body exceeds the size limit', retryable: false },
  ERR_UNSUPPORTED_MEDIA_TYPE: { http: 415, message: 'Unsupported content type', retryable: false },
  ERR_CONFLICT_IDEMPOTENCY: { http: 409, message: 'Idempotency key reused with a different payload', retryable: false },
  // The single most common integration mistake, caught with an explanation.
  ERR_CONFLICT_NS_RETRY: {
    http: 409,
    message: 'Rejected by SdI (NS). NS is terminal — the invoice is legally not issued. Correct it and submit a NEW invoice; PASSO will allocate a new ProgressivoInvio.',
    retryable: false,
  },
  ERR_CONFLICT_TERMINAL: { http: 409, message: 'Submission is already in a terminal state', retryable: false },
  ERR_CONFLICT_MC_RETRY: { http: 409, message: 'MC means SdI is still attempting delivery. Resubmitting would duplicate the invoice.', retryable: false },
  ERR_INTERNAL: { http: 500, message: 'Internal error', retryable: true },
} as const satisfies Record<string, ErrorDef>;

export type ErrorCode = keyof typeof ERRORS;

export class ApiError extends Error {
  readonly http: number;
  readonly retryable: boolean;
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  readonly details: unknown[] | undefined;
  constructor(code: ErrorCode, detail?: string, details?: unknown[]) {
    const def = ERRORS[code];
    super(detail ? `${def.message}: ${detail}` : def.message);
    this.code = code;
    this.detail = detail;
    this.details = details;
    this.http = def.http;
    this.retryable = def.retryable;
  }
  toJSON() {
    return {
      error: {
        code: this.code, message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}
