/**
 * Optional Bearer authentication for the /api/process/* endpoints.
 * When PROCESSING_API_KEY is unset, auth is skipped entirely.
 * /health is always public (Render health checks need it).
 */
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './errors.js';

export function requireBearerAuth(apiKey: string | undefined) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!apiKey) return next();
    const header = req.header('authorization') ?? '';
    const expected = `Bearer ${apiKey}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    const match = a.length === b.length && timingSafeEqual(a, b);
    if (!match) {
      next(ApiError.unauthorized());
      return;
    }
    next();
  };
}
