/**
 * Typed API errors + the Express error handler.
 * Every failure returns JSON: { ok: false, error: { code, message } }.
 */
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  static badRequest(message: string, code = 'bad_request'): ApiError {
    return new ApiError(400, code, message);
  }

  static unauthorized(message = 'Missing or invalid Authorization header.'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static notFound(message = 'Not found.'): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static payloadTooLarge(message: string): ApiError {
    return new ApiError(413, 'payload_too_large', message);
  }

  static unsupportedMedia(message: string): ApiError {
    return new ApiError(415, 'unsupported_media_type', message);
  }

  static unavailable(message: string, code = 'service_unavailable'): ApiError {
    return new ApiError(503, code, message);
  }

  static timeout(message: string): ApiError {
    return new ApiError(504, 'timeout', message);
  }

  static upstream(message: string, code = 'upstream_error'): ApiError {
    return new ApiError(502, code, message);
  }
}

export type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    console.error(`[error] ${req.method} ${req.path} (headers already sent)`, err);
    return;
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        ok: false,
        error: { code: 'payload_too_large', message: 'Uploaded file exceeds the maximum allowed size.' },
      });
      return;
    }
    res.status(400).json({
      ok: false,
      error: { code: 'upload_error', message: err.message },
    });
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.status).json({
      ok: false,
      error: { code: err.code, message: err.message },
    });
    return;
  }
  // express.json() body-parse failures arrive as SyntaxError with a `body` prop.
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      ok: false,
      error: { code: 'invalid_json', message: 'Request body is not valid JSON.' },
    });
    return;
  }
  console.error(`[error] ${req.method} ${req.path}`, err);
  res.status(500).json({
    ok: false,
    error: { code: 'internal_error', message: 'Internal server error.' },
  });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    ok: false,
    error: { code: 'not_found', message: 'Route not found.' },
  });
}
