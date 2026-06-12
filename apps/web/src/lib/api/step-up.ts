/**
 * PII step-up (7b-OTP, D-P5.5/7/8) API client — 7c FE half (F1).
 *
 * Flow: a privileged fetch (sensitive-document download, tabu review
 * rows/PATCH/confirm) returns 403 `{ error: { code: 'pii_step_up_required' } }`
 * → the FE opens the unlock dialog (`useStepUpUnlock`) → POST
 * /auth/step-up/request (emails a 6-digit code to the CALLER) → the user
 * types the code → POST /auth/step-up/verify { code } → on 200 the caller's
 * CURRENT session is stamped `pii_unlocked_at` and the original action is
 * retried.
 *
 * Security posture:
 *  - `pii_step_up_required` is DISTINCT from plain `forbidden` — only the
 *    former triggers the modal (a permissions 403 must never imply "try an
 *    OTP and you're in").
 *  - The request endpoint MAY return `data.code` under the dev/QA exposure
 *    gate (EXPOSE_STEP_UP_CODE, non-production only). We deliberately DO NOT
 *    read or auto-fill it — the user always types the code (parity with the
 *    production email path; also keeps the dev code out of React state).
 *  - The code itself is never logged and never appears in an error message.
 */
import { z } from 'zod';

import { apiClient, isOk } from '../api-client';

import { ApiClientError } from './errors';

/** 403 code minted by the BE sensitive-document / tabu-review gates. */
export const PII_STEP_UP_REQUIRED_CODE = 'pii_step_up_required' as const;

/** 401 code for a wrong/expired/burned step-up code (form-level, suppressed
 *  from the global unauthenticated event — see api-client SUPPRESS_EVENT). */
export const STEP_UP_INVALID_CODE = 'invalid_step_up_code' as const;

/** The D.16-normalized envelope code for a Nest @Throttle 429. */
export const RATE_LIMITED_CODE = 'http_429' as const;

/** Is this error the step-up gate (NOT a plain `forbidden`)? */
export function isStepUpRequired(e: unknown): boolean {
  return e instanceof ApiClientError && e.code === PII_STEP_UP_REQUIRED_CODE;
}

// `code` (dev/QA exposure) is intentionally NOT modeled — we never read it.
const StepUpOkSchema = z.object({ ok: z.literal(true) }).passthrough();

/** POST /auth/step-up/request — email a 6-digit OTP to the caller.
 *  Silently rate-limited server-side (3/15min per user); per-IP @Throttle
 *  429s surface as `http_429`. */
export async function requestStepUpCode(): Promise<void> {
  const res = await apiClient.post<unknown>('/auth/step-up/request', {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  StepUpOkSchema.parse(res.data);
}

/** POST /auth/step-up/verify { code } — stamp the unlock on the caller's
 *  CURRENT session. Wrong/expired/burned code → 401 `invalid_step_up_code`
 *  (generic by design — never reveals remaining attempts). */
export async function verifyStepUpCode(code: string): Promise<void> {
  const res = await apiClient.post<unknown>('/auth/step-up/verify', { code });
  if (!isOk(res)) throw new ApiClientError(res.error);
  StepUpOkSchema.parse(res.data);
}
