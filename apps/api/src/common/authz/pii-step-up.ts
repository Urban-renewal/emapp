import { authSessions, type TenantTx } from '@emapp/db';
import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { AccessTokenPayload } from '../../modules/auth/auth.service';
import { getOrgSettings } from '../org-settings.resolver';

/**
 * 7b-OTP (D-P5.5/7/8) — the canonical PII step-up ACCESS gate, shared by every
 * surface that materializes decrypted owner PII behind a per-session unlock.
 *
 * 403 — the FE opens the step-up OTP dialog. Only ever thrown AFTER the
 * caller's per-record visibility check has passed, so it is NEVER an existence
 * oracle. (Callers MUST keep this ordering.)
 */
export const PII_STEP_UP_REQUIRED = new ForbiddenException({
  error: { code: 'pii_step_up_required', message: 'נדרש אימות נוסף לצפייה במידע רגיש' },
});

/**
 * THE single source of truth for the step-up ACCESS check (the freshness/TTL
 * half). The caller's CURRENT session (`user.sid`) must hold a VALID unlock:
 * `auth_sessions.pii_unlocked_at` NOT NULL AND younger than the org's
 * `security.piiUnlockTtlMinutes` (default 60). Fail-closed: an unknown/ghost/
 * revoked sid finds no row → locked → 403.
 *
 * IMPORTANT — this is ONLY the ACCESS gate (may the session reveal PII at all
 * right now?). It is DELIBERATELY SEPARATE from the cleartext-vs-masked
 * decision, which DIVERGES by surface and is NOT decided here:
 *
 *   - Tabu row review (`TabuExtractionsService`) reveals PII PER-FIELD and masks
 *     `national_id` at the sink via `resolveOwnerPiiFidelity` (D.54): a viewer /
 *     an agent WITHOUT `view_owner_pii` still passes THIS access gate but only
 *     ever sees the •-masked id. So a masked-role review is a legitimate caller
 *     — the access gate must NOT additionally require cleartext entitlement.
 *
 *   - Sensitive-document download (`DocumentsService`) serves a WHOLE FILE, all
 *     or nothing — there is no per-field mask. Its cleartext contract therefore
 *     differs and any additional entitlement check belongs at THAT call site,
 *     never inside this shared helper.
 *
 * Each call site documents WHY its cleartext contract differs; this helper owns
 * ONLY the common access check so the two can never silently drift apart again.
 *
 * Runs inside the caller's `withTenant` tx. `auth_sessions` is auth-infra (no
 * RLS; `app_user` has SELECT).
 */
export async function assertSessionPiiUnlocked(
  tx: TenantTx,
  user: AccessTokenPayload,
): Promise<void> {
  const { security } = await getOrgSettings(tx, user.orgId);
  const ttlMs = security.piiUnlockTtlMinutes * 60_000;
  const [sess] = await tx
    .select({ piiUnlockedAt: authSessions.piiUnlockedAt })
    .from(authSessions)
    .where(eq(authSessions.id, user.sid))
    .limit(1);
  const unlockedAt = sess?.piiUnlockedAt ?? null;
  if (!unlockedAt || unlockedAt.getTime() + ttlMs <= Date.now()) {
    throw PII_STEP_UP_REQUIRED;
  }
}
