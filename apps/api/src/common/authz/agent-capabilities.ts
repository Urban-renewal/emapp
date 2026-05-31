import { memberships, type TenantTx } from '@emapp/db';
import type { AgentCapabilityKey } from '@emapp/shared-types';
import { ForbiddenException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import type { AccessTokenPayload } from '../../modules/auth/auth.service';

const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

/**
 * D.46 — enforce a per-agent capability AFTER the coarse AuthorizationGuard
 * has allowed the (role, resource, action), and AFTER the service's own
 * record-scoping (agent → assigned project). The capability is the FINE half
 * the role-only guard cannot see (capabilities live in JSONB, not the JWT).
 *
 *   - manager → implicitly holds EVERY capability (no-op pass).
 *   - agent   → must have the specific flag === true in
 *               `memberships.capabilities`; otherwise 403.
 *   - anyone else (viewer / unknown) → 403 (defense-in-depth; POLICY already
 *     excludes them coarsely, but a loosened cell must never fall open).
 *
 * Runs inside the caller's `withTenant` tx — `memberships` is org-scoped by
 * RLS, so the SELECT returns exactly this agent's own active membership row.
 *
 * GUARDRAIL (D.46): every endpoint on a POLICY cell that was loosened to
 * include `agent` MUST call this — otherwise the loosening opens an ungated
 * side door. Pinned by the capability specs + verified in security review.
 */
export async function requireAgentCapability(
  tx: TenantTx,
  user: AccessTokenPayload,
  capability: AgentCapabilityKey,
): Promise<void> {
  if (user.role === 'manager') return;
  if (user.role !== 'agent') throw FORBIDDEN;
  const [m] = await tx
    .select({ capabilities: memberships.capabilities })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, user.sub),
        eq(memberships.orgId, user.orgId),
        isNull(memberships.revokedAt),
      ),
    )
    .limit(1);
  if (!m || m.capabilities[capability] !== true) throw FORBIDDEN;
}

/**
 * D.54 — can this actor see owner records AT ALL? Manager + viewer are org read
 * roles → yes. Agent → only with `view_owners`. This mirrors the JSON gate
 * (`OwnersService.assertAgentCanViewOwners`) so a read-scope-aware surface like
 * the export (D.50) omits owner rows the actor cannot see on screen.
 */
export async function canViewOwners(tx: TenantTx, user: AccessTokenPayload): Promise<boolean> {
  if (user.role === 'manager') return true;
  if (user.role !== 'agent') return true; // viewer + other org read roles
  const [m] = await tx
    .select({ capabilities: memberships.capabilities })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, user.sub),
        eq(memberships.orgId, user.orgId),
        isNull(memberships.revokedAt),
      ),
    )
    .limit(1);
  return m?.capabilities.view_owners === true;
}

/** Owner-PII read fidelity (D.54). */
export type OwnerPiiFidelity = 'masked' | 'unmasked';

/**
 * D.54 — THE single source of truth for owner-PII read fidelity. Every surface
 * that shows owner national_id/phone (owners list/detail/edit, ownerships
 * apartment-owners, export) resolves through THIS — never an ad-hoc per-site
 * decision.
 *
 *   - manager → `unmasked` (their authorized view, D.50).
 *   - agent   → `unmasked` IFF `view_owner_pii === true`, else `masked`.
 *   - viewer / anyone else → `masked` (D.47/D.50: export reflects on-screen
 *     fidelity; a viewer never sees cleartext).
 *
 * Default is masked (least-privilege). Runs inside `withTenant` so the
 * `memberships` read is RLS-org-scoped. Granting `unmasked` is audited at the
 * capability-toggle (`member.capabilities_change`).
 */
export async function resolveOwnerPiiFidelity(
  tx: TenantTx,
  user: AccessTokenPayload,
): Promise<OwnerPiiFidelity> {
  if (user.role === 'manager') return 'unmasked';
  if (user.role !== 'agent') return 'masked';
  const [m] = await tx
    .select({ capabilities: memberships.capabilities })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, user.sub),
        eq(memberships.orgId, user.orgId),
        isNull(memberships.revokedAt),
      ),
    )
    .limit(1);
  return m?.capabilities.view_owner_pii === true ? 'unmasked' : 'masked';
}
