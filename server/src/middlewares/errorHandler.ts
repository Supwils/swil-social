import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { isProd } from '../config/env';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(
    new AppError('NOT_FOUND', 404, `Cannot ${req.method} ${req.originalUrl}`),
  );
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = (req as unknown as { id?: string }).id;

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error({ err, requestId }, 'handled 5xx');
    } else if (err.status >= 400 && err.status < 500) {
      logger.debug({ err: { code: err.code, message: err.message }, requestId }, 'client error');
    }
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.fields ? { fields: err.fields } : {}),
        requestId,
      },
    });
    return;
  }

  logger.error({ err, requestId }, 'unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: isProd ? 'Internal server error' : (err as Error)?.message ?? 'Unknown error',
      requestId,
    },
  });
};
