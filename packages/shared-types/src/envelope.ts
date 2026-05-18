import { z } from 'zod';

// D.16 response envelope — the single shape both apps rely on.

/** Success: a single resource. */
export interface ApiData<T> {
  data: T;
}

/** Cursor-paginated list (D.16). */
export interface ApiList<T> {
  data: T[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

/** Error envelope. FE switches on `error.code` — never parses `message`. */
export interface ApiError {
  error: { code: string; message?: string; details?: unknown };
}

export type ApiResponse<T> = ApiData<T> | ApiError;

/** Zod validator for the error envelope (tests/FE can `.parse()`). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

/** Build a Zod validator for `{ data: <schema> }`. */
export function apiData<T extends z.ZodTypeAny>(schema: T): z.ZodObject<{ data: T }> {
  return z.object({ data: schema });
}

/** Build a Zod validator for a cursor-paginated `{ data:[], page }`. */
export function apiList<T extends z.ZodTypeAny>(schema: T) {
  return z.object({
    data: z.array(schema),
    page: z.object({
      limit: z.number().int().positive(),
      cursor: z.string().nullable(),
      has_more: z.boolean(),
    }),
  });
}

/** Runtime narrow: did the call succeed (vs an error envelope)? */
export function isOk<T>(r: ApiResponse<T>): r is ApiData<T> {
  return 'data' in r;
}
