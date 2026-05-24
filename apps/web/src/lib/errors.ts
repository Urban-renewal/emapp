/**
 * Helpers for mapping the D.16 error envelope to UI surfaces.
 *
 * The API's Zod pipe writes `{ error: { code: 'validation_error',
 * details: result.error.flatten().fieldErrors } }` —
 * `details` is a `Record<string, string[]>` keyed by request field name.
 *
 * Forms use react-hook-form; `applyValidationErrors` walks `details`
 * and calls `setError(field, { message })` for each entry, so the
 * existing field-level error rendering picks them up without per-form
 * mapping code.
 */
import type { ApiError } from '@emapp/shared-types';

type FieldErrorSetter = (field: string, message: string) => void;

export function isValidationError(err: ApiError['error']): err is ApiError['error'] & {
  details: Record<string, string[]>;
} {
  if (err.code !== 'validation_error') return false;
  const d = err.details;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  return Object.values(d as Record<string, unknown>).every(
    (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
  );
}

/** Apply server-side field errors to a react-hook-form (or any setter
 *  matching the shape). Returns the list of fields that received errors
 *  so callers can decide whether to also show a top-level toast. */
export function applyValidationErrors(
  err: ApiError['error'],
  setError: FieldErrorSetter,
): string[] {
  if (!isValidationError(err)) return [];
  const applied: string[] = [];
  for (const [field, messages] of Object.entries(err.details)) {
    const first = messages[0];
    if (typeof first === 'string') {
      setError(field, first);
      applied.push(field);
    }
  }
  return applied;
}
