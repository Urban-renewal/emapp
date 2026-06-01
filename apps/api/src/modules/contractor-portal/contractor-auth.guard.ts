import { isOrgSuspended, shares, withTenant } from '@emapp/db';
import type { SharePermissions } from '@emapp/shared-types';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import { ShareTokenService } from './share-token.service';

/**
 * D2-DEF-1 — ContractorAuthGuard. A PARALLEL auth tier, deliberately
 * OUTSIDE the org POLICY matrix (`policy.ts` knows only manager/agent/
 * viewer) — a contractor has no role; authority comes ENTIRELY from the
 * share's JSONB permissions. No `@AuthzResource` / `AuthorizationGuard` is
 * stacked on contractor endpoints; this guard is the sole gate.
 *
 * Per request it:
 *   1. extracts the share-access token (cookie or Bearer),
 *   2. verifies it (audience `emapp-share` — token-confusion proof),
 *   3. loads the bound `shares` row under the token's org RLS and refuses
 *      if it is missing / REVOKED (revoked_at), or the org is SUSPENDED
 *      (D.49) — every one of these is a generic 401 (no oracle),
 *   4. attaches `req.contractor` = { the token + the live `permissions` }.
 *
 * Revocation is immediate: `shares.revoked_at` is checked on EVERY request,
 * so the 30-day token TTL never outlives a manager's revoke.
 */
export interface ContractorContext {
  /** contractor id (token sub). */
  contractorId: string;
  projectId: string;
  shareId: string;
  orgId: string;
  /** The LIVE share permissions (re-read each request — not from the token). */
  permissions: SharePermissions;
}

@Injectable()
export class ContractorAuthGuard implements CanActivate {
  constructor(private readonly shareToken: ShareTokenService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const cookie = (req.cookies as Record<string, string | undefined>)?.['contractor_access_token'];
    const header = req.headers['authorization'];
    const token = cookie ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!token) throw new UnauthorizedException({ error: { code: 'missing_token' } });

    // Throws ShareTokenVerifyError (→ 401 invalid_token) on any failure.
    const payload = this.shareToken.verify(token);

    // Load the bound share under the token's org RLS. A forged orgId can't
    // see another org's share row (RLS), and a revoked/suspended share is
    // indistinguishable from a non-existent one → generic 401 (no oracle).
    const share = await withTenant(payload.orgId, async (tx) => {
      if (await isOrgSuspended(tx, payload.orgId)) return null;
      const [row] = await tx
        .select({ permissions: shares.permissions })
        .from(shares)
        .where(
          and(
            eq(shares.id, payload.shareId),
            eq(shares.projectId, payload.projectId),
            eq(shares.contractorId, payload.sub),
            isNull(shares.revokedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    });
    if (!share) throw new UnauthorizedException({ error: { code: 'invalid_token' } });

    const contractor: ContractorContext = {
      contractorId: payload.sub,
      projectId: payload.projectId,
      shareId: payload.shareId,
      orgId: payload.orgId,
      permissions: share.permissions,
    };
    (req as FastifyRequest & { contractor: ContractorContext }).contractor = contractor;
    return true;
  }
}
