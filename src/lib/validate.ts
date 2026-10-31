import type { ZodType } from 'zod';
import { ApiError } from './errors.js';

/** Parses a request body, turning schema failures into a 400 envelope. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new ApiError(400, 'VALIDATION_ERROR', detail);
  }

  return result.data;
}
