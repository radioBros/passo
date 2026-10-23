import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError, ERRORS, type ErrorCode } from '../../shared/errors/catalog.ts';
import { XsdError } from '../../infra/render/xsd.ts';
import { RenderError } from '../../infra/render/xslt.ts';
import { ChannelError } from '../../infra/channels/types.ts';
import { logger } from '../../shared/logger.ts';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  req.requestId = req.header('x-request-id') ?? randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}

export function errorHandler(
  err: unknown, req: Request, res: Response, _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    // 404 rather than 403 for cross-tenant misses: a 403 would confirm the
    // resource exists inside another tenant.
    logger.warn({ code: err.code, requestId: req.requestId }, 'api error');
    res.status(err.http).json({ ...err.toJSON(), requestId: req.requestId });
    return;
  }
  /**
   * A document that failed the mandatory XSD gate (API-010 stage 4).
   *
   * `XsdError` is not an `ApiError`, so without this it fell through to a bare
   * 500 with `retryable: true` — telling a CRM to keep retrying a document that
   * can NEVER validate. The XSD is deterministic: the same bytes fail the same
   * way forever.
   *
   * The individual schema errors are returned because they name the offending
   * element by its exact FatturaPA path, which is the only actionable thing
   * about an XSD failure.
   */
  if (err instanceof XsdError) {
    logger.warn({ requestId: req.requestId, details: err.details }, 'xsd validation failed');
    res.status(422).json({
      error: {
        code: 'ERR_XSD_INVALID',
        message: 'The generated FatturaPA XML failed validation against the official XSD',
        retryable: false,
        details: err.details.slice(0, 20),
      },
      requestId: req.requestId,
    });
    return;
  }

  /**
   * A rendering refusal — a malformed document or one carrying a DOCTYPE.
   *
   * Left unmapped this was a 500 with `retryable: true`, telling a CRM to keep
   * retrying a document that can never render, and hiding the actual reason.
   */
  if (err instanceof RenderError) {
    logger.warn({ requestId: req.requestId, reason: err.message }, 'render refused');
    res.status(422).json({
      error: {
        code: 'ERR_RENDER_FAILED', message: err.message, retryable: false,
      },
      requestId: req.requestId,
    });
    return;
  }

  /**
   * A channel-level refusal (SDI-019). `ChannelError` carries its own
   * retryability, which the worker uses to choose retry versus DLQ — the same
   * flag decides whether the HTTP caller should try again.
   */
  if (err instanceof ChannelError) {
    logger.warn({ requestId: req.requestId, code: err.code }, 'channel error');
    const code = (err.code && err.code in ERRORS ? err.code : 'ERR_CHANNEL_UNAVAILABLE') as ErrorCode;
    res.status(ERRORS[code].http).json({
      error: { code, message: err.message, retryable: err.retryable },
      requestId: req.requestId,
    });
    return;
  }

  /**
   * `body-parser` rejections are client faults, not server faults. Left
   * unmapped they surface as a 500, which tells a CRM to retry a request that
   * can never succeed — an oversized invoice would then retry forever.
   */
  const e = err as { type?: string; status?: number; statusCode?: number };
  const kind = e.type ?? '';
  if (kind === 'entity.too.large') {
    res.status(413).json({
      error: { code: 'ERR_PAYLOAD_TOO_LARGE', message: 'Request body exceeds the size limit', retryable: false },
      requestId: req.requestId,
    });
    return;
  }
  if (kind === 'encoding.unsupported' || (e.status ?? e.statusCode) === 415) {
    res.status(415).json({
      error: { code: 'ERR_UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported content type', retryable: false },
      requestId: req.requestId,
    });
    return;
  }
  if (kind === 'entity.parse.failed') {
    res.status(400).json({
      error: { code: 'ERR_SCHEMA_INVALID', message: 'Malformed request body', retryable: false },
      requestId: req.requestId,
    });
    return;
  }

  logger.error({ err, requestId: req.requestId }, 'unhandled error');
  res.status(500).json({
    error: { code: 'ERR_INTERNAL', message: 'Internal error', retryable: true },
    requestId: req.requestId,
  });
}

export function notFound(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'ERR_NOT_FOUND', message: 'Resource not found', retryable: false },
    requestId: req.requestId,
  });
}
