import { contractors, isOrgSuspended, projects, shares, withTenant } from '@emapp/db';
import type { SharePermissions } from '@emapp/shared-types';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import { ShareTokenService } from './share-token.service';

// Throttle the access-tracking write so a valid contractor read is not a DB
// write on every request — once per 5 min is plenty for an engagement signal.
const LAST_ACCESS_THROTTLE_MS = 5 * 60 * 1000;

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
 *   3. ENFORCES the token's `exp` at RETRIEVAL — fail-closed, generic 401 —
 *      so an expired/over-TTL credential is rejected on EVERY read/download,
 *      not merely on listing (red-team blocker: a long-lived JWT must NOT
 *      outlive the share's intended lifetime),
 *   4. loads the bound `shares` row under the token's org RLS and refuses
 *      if it is missing / REVOKED (revoked_at), the bound CONTRACTOR is
 *      ARCHIVED (contractors.archived_at — #4), the bound PROJECT is ARCHIVED
 *      (projects.archived_at — #5), or the org is SUSPENDED (D.49) — every one
 *      of these is a generic 401 (no oracle),
 *   5. attaches `req.contractor` = { the token + the live `permissions` }.
 *
 * Revocation is immediate: `shares.revoked_at` is checked on EVERY request,
 * so the token TTL never outlives a manager's revoke.
 *
 * ARCHIVE-CUTS-ACCESS (#4 + #5, cross-entity authz): a share whose `revoked_at`
 * is still NULL must NOT keep granting access once the partner is OFFBOARDED
 * (contractor archived) or the project is ARCHIVED. The legacy `shares` table
 * carries no archive column of its own, so the live re-check joins the bound
 * `contractors` + `projects` rows and FAILS CLOSED if either is archived —
 * exactly where revocation + suspension are already enforced (one seam, not a
 * second access path). A manager who archives a contractor or a project cuts
 * external read access on the VERY NEXT request, not after the token TTL.
 *
 * EXPIRY (SECURITY, share-expiry-on-retrieval): `ShareTokenService.verify()`
 * already throws on an expired JWT, but the legacy `shares` table has NO
 * `expires_at` column — so the token's own `exp` claim IS the share's intended
 * lifetime, and it is the ONLY expiry signal available without a schema
 * migration. We therefore RE-ASSERT `exp` here, at retrieval, as an explicit
 * fail-closed gate independent of the verify path: even if a future verify
 * refactor stopped rejecting an aged token (or a token were minted/replayed
 * with a stale `exp`), this guard still refuses every document read once the
 * credential's lifetime has passed. A per-share, manager-settable `expires_at`
 * (shorter than the token TTL) is a SEPARATE, migration-bearing change and is
 * deliberately NOT introduced here.
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
  private readonly logger = new Logger(ContractorAuthGuard.name);

  constructor(private readonly shareToken: ShareTokenService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const cookie = (req.cookies as Record<string, string | undefined>)?.['contractor_access_token'];
    const header = req.headers['authorization'];
    const token = cookie ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!token) throw new UnauthorizedException({ error: { code: 'missing_token' } });

    // Throws ShareTokenVerifyError (→ 401 invalid_token) on any failure.
    const payload = this.shareToken.verify(token);

    // RETRIEVAL-TIME EXPIRY (fail-closed, no-oracle). `verify()` already rejects
    // an expired JWT, but we RE-ASSERT the `exp` here so expiry is enforced on
    // every contractor read/download as an explicit gate — not implicitly via
    // the verify path. `exp` is seconds-since-epoch (JWT spec); reject the
    // instant it is reached or passed. The `typeof !== 'number'` clause makes
    // this gate SELF-SUFFICIENT: an exp-less/non-numeric payload would make
    // `exp * 1000` NaN and `NaN <= now` false (fail-OPEN) — so we reject a
    // missing/malformed exp outright rather than relying on verify()'s shape
    // check still being there after a future refactor. Same generic 401 as a
    // revoked/forged token → an attacker cannot distinguish "expired" from "invalid".
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }

    // Load the bound share under the token's org RLS. A forged orgId can't
    // see another org's share row (RLS), and a revoked/suspended share is
    // indistinguishable from a non-existent one → generic 401 (no oracle).
    const share = await withTenant(payload.orgId, async (tx) => {
      if (await isOrgSuspended(tx, payload.orgId)) return null;
      const [row] = await tx
        .select({ permissions: shares.permissions, lastAccessedAt: shares.lastAccessedAt })
        .from(shares)
        // #4 + #5 — archiving the contractor OR the project cuts access LIVE.
        // INNER joins + `archived_at IS NULL` make an archived contractor/
        // project drop the row → generic 401 (no oracle), same as revoked.
        .innerJoin(contractors, eq(contractors.id, shares.contractorId))
        .innerJoin(projects, eq(projects.id, shares.projectId))
        .where(
          and(
            eq(shares.id, payload.shareId),
            eq(shares.projectId, payload.projectId),
            eq(shares.contractorId, payload.sub),
            isNull(shares.revokedAt),
            isNull(contractors.archivedAt), // #4 offboarded contractor → denied
            isNull(projects.archivedAt), // #5 archived project → denied
          ),
        )
        .limit(1);
      if (!row) return null;

      // Best-effort access tracking — surfaces "did the partner ever open the
      // link?" to the manager (shares.lastAccessedAt was written nowhere before).
      // Throttled + try/catch: access-tracking must NEVER break or slow a valid
      // contractor read, and runs under the same org-RLS app_user that managers
      // already use to write shares.
      const last = row.lastAccessedAt ? row.lastAccessedAt.getTime() : 0;
      if (Date.now() - last > LAST_ACCESS_THROTTLE_MS) {
        try {
          await tx
            .update(shares)
            // Defense-in-depth: re-assert not-revoked so the WRITE predicate is
            // never narrower than the validated-read predicate (it can't drift
            // into touching a same-org share that wasn't the one we authorized).
            .set({ lastAccessedAt: new Date() })
            .where(and(eq(shares.id, payload.shareId), isNull(shares.revokedAt)));
        } catch (e) {
          this.logger.warn(
            `contractor lastAccessedAt update skipped: ${(e as Error).constructor.name}`,
          );
        }
      }
      return { permissions: row.permissions };
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
