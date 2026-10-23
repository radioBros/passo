import type { Request, Response, NextFunction } from 'express';
import type { Db } from '../../infra/db/pool.ts';
import { resolveApiKey, checkAdminKey } from '../../domain/apikey/service.ts';
import { ApiError } from '../../shared/errors/catalog.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantId?: string;
      keyId?: string;
      scopes?: string[];
      isAdmin?: boolean;
      requestId?: string;
    }
  }
}

const bearer = (req: Request): string | null => {
  const h = req.header('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
};

/** Tenant is derived from the API key, NEVER from a request parameter or body. */
export function tenantAuth(db: Db) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = bearer(req);
      if (!token) throw new ApiError('ERR_AUTH_MISSING');
      const k = await resolveApiKey(db, token);
      req.tenantId = k.tenantId;
      req.keyId = k.id;
      req.scopes = k.scopes;

      /**
       * Deprecation headers for a key in its rotation grace window (KEY-011).
       *
       * The old key still works, which is the point — but a caller who never
       * notices will be cut off when the window closes. These headers are the
       * standard way to say so, and `Sunset` gives the exact deadline.
       */
      if (k.graceExpiresAt) {
        res.setHeader('deprecation', 'true');
        res.setHeader('sunset', k.graceExpiresAt.toUTCString());
        res.setHeader('link', '</api/admin.html#rotating-a-key>; rel="deprecation"');
      }
      next();
    } catch (e) { next(e); }
  };
}

export function adminAuth(adminKey: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = bearer(req);
    if (!token) return next(new ApiError('ERR_AUTH_MISSING'));
    if (!checkAdminKey(token, adminKey)) return next(new ApiError('ERR_AUTH_INVALID'));
    req.isAdmin = true;
    next();
  };
}

export function requireScope(scope: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.isAdmin) return next();
    if (!req.scopes?.includes(scope)) return next(new ApiError('ERR_AUTH_SCOPE', scope));
    next();
  };
}
