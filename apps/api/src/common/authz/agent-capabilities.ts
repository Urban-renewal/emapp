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
