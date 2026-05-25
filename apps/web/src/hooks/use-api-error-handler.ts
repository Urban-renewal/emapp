'use client';

import { useCallback, useState } from 'react';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { ApiClientError } from '@/lib/api/errors';
import { applyValidationErrors } from '@/lib/errors';

/**
 * §SOLID-M7 closure — single, consistent API-error handler for forms.
 *
 * Was duplicated 4 times across forms (projects/new, owners/new,
 * projects/[id]/buildings/new, buildings/[id]/apartments/new) AND
 * INCONSISTENT — imports/new and signature-requests/new dropped to a
 * generic toast string, losing per-field BE validation errors entirely.
 *
 * This hook collapses the pattern to ONE shape:
 *
 *   const { serverError, handle, reset } = useApiErrorHandler({
 *     setError,
 *     codeOverrides: {
 *       owner_exists: (set) => set('national_id', t('field.idExists')),
 *       signature_request_pending_exists: () => t('pendingExists'),
 *     },
 *     fallback: () => t('createFailed'),
 *   });
 *   // in catch:
 *   handle(e);
 *
 * Behavior contract:
 *  - If `e` is NOT an ApiClientError → fallback() returns the message.
 *  - If `e.code` is in `codeOverrides`:
 *      - override returns string → that's the serverError
 *      - override returns void → caller already called setError; no
 *        serverError is shown.
 *  - If `e.code === 'validation_error'` → applyValidationErrors. If
 *    no fields matched → fallback() shows the generic.
 *  - Otherwise → fallback() shows the generic.
 *
 * Always-defensive: never throws, never logs PII, always coerces to a
 * displayable string when fallback returns one.
 */

export interface UseApiErrorHandlerOptions<TForm extends FieldValues> {
  /** react-hook-form setError. Optional — omit if the form doesn't
   *  use per-field errors. */
  setError?: UseFormSetError<TForm>;
  /** Map of BE error codes → handler. Return string for serverError,
   *  void if you already called setError. */
  codeOverrides?: Partial<
    Record<string, (setError: UseFormSetError<TForm> | undefined) => string | void>
  >;
  /** Fallback message when nothing else matched. Required. */
  fallback: () => string;
}

export function useApiErrorHandler<TForm extends FieldValues>(
  opts: UseApiErrorHandlerOptions<TForm>,
) {
  const [serverError, setServerError] = useState<string | null>(null);

  const handle = useCallback(
    (e: unknown) => {
      // Non-ApiClientError → generic.
      if (!(e instanceof ApiClientError)) {
        setServerError(opts.fallback());
        return;
      }
      // Code override first (specific over general).
      const override = opts.codeOverrides?.[e.code];
      if (override) {
        const msg = override(opts.setError);
        if (typeof msg === 'string') setServerError(msg);
        return;
      }
      // validation_error: walk details + setError on each field.
      if (e.code === 'validation_error' && opts.setError) {
        const env = { code: e.code, message: e.message, details: e.details };
        const applied = applyValidationErrors(env, (field, message) => {
          // The double cast is needed because the helper is generic over
          // field strings but RHF expects `Path<TForm>`. This is safe —
          // BE field names must match form field names by contract; if
          // they don't, the setError is a no-op.
          opts.setError?.(field as Path<TForm>, { type: 'server', message });
        });
        if (applied.length === 0) setServerError(opts.fallback());
        return;
      }
      // Anything else → generic.
      setServerError(opts.fallback());
    },
    [opts],
  );

  const reset = useCallback(() => setServerError(null), []);

  return { serverError, handle, reset, setServerError };
}
