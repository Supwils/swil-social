import type { Request, Response, NextFunction, RequestHandler } from 'express';

type Async = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncHandler(fn: Async): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
