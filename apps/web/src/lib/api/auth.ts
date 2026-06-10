/**
 * Auth API client — self-service password reset (P1 R0.1).
 *
 * BE contract (PUBLIC — no session):
 *   POST /api/v1/auth/forgot-password → { data: { ok: true, message } }
 *                                       (ALWAYS 200 — anti-enumeration)
 *   POST /api/v1/auth/reset-password  → { data: { ok: true } }
 *                                       400/401 `invalid_reset_token` on a
 *                                       bad/expired/used token (generic).
 *
 * Defensive Zod parse of the BODY before the wire (Doc 06 §5 pattern) so a
 * malformed client value never reaches the network.
 */
import {
  ForgotPasswordSchema,
  ResetPasswordSchema,
  type ForgotPasswordDto,
  type ResetPasswordDto,
} from '@emapp/shared-types';

import { apiClient, isOk } from '../api-client';

import { ApiClientError } from './errors';

/** Request a reset link. ALWAYS resolves (the BE returns a generic 200
 *  regardless of whether the email exists). A transport/5xx error still
 *  rejects so the form can show a generic retry message. */
export async function forgotPassword(body: ForgotPasswordDto): Promise<{ ok: true }> {
  const validated = ForgotPasswordSchema.parse(body);
  const res = await apiClient.post<unknown>('/auth/forgot-password', validated, {
    // Public, pre-auth — never trigger the silent-refresh path on a 401.
    noRefresh: true,
  });
  if (isOk(res)) return { ok: true };
  throw new ApiClientError(res.error);
}

/** Consume a reset token + set a new password. Throws `ApiClientError`
 *  (code `invalid_reset_token` / `validation_error`) on failure — the page
 *  collapses every failure to a single generic message (no oracle). */
export async function resetPassword(body: ResetPasswordDto): Promise<{ ok: true }> {
  const validated = ResetPasswordSchema.parse(body);
  const res = await apiClient.post<unknown>('/auth/reset-password', validated, {
    noRefresh: true,
  });
  if (isOk(res)) return { ok: true };
  throw new ApiClientError(res.error);
}
