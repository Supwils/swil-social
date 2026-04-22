import type { Response } from 'express';

export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({
    data,
    meta: { requestId: (res as unknown as { reqId?: string }).reqId },
  });
}

export function noContent(res: Response): Response {
  return res.status(204).end();
}
