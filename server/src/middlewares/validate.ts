import type { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { AppError } from '../lib/errors';

type Source = 'body' | 'query' | 'params';

export function validate(schema: ZodSchema, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const input = (req as unknown as Record<Source, unknown>)[source];
    const result = schema.safeParse(input);
    if (!result.success) {
      const fields: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_';
        if (!fields[key]) fields[key] = issue.message;
      }
      return next(AppError.validation('Invalid request', fields));
    }
    (req as unknown as Record<Source, unknown>)[source] = result.data;
    next();
  };
}
