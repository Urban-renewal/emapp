/**
 * D.49 — Provider Admin tenant suspend / reactivate service.
 *
 * `POST /provider/tenants/:id/suspend`     — freeze an org operationally.
 * `POST /provider/tenants/:id/reactivate`  — lift the suspension.
 *
 * Both mutations run THROUGH `withProvider` (the audit-first path):
 *   - The `provider_audit_log` row (`action='provider.tenant.suspended'`
 *     / `'provider.tenant.reactivated'`) is committed in an AUTONOMOUS
 *     transaction BEFORE the UPDATE runs (SA-7). A crafted failure in the
 *     work tx can never erase the forensic record of the attempt.
 *   - `access_reason` is mandatory (enforced upstream by @AccessReason +
 *     re-validated inside withProvider) — it lands in the audit row's
 *     `reason` column, NOT on the org.
 *
 * `suspended_at` uses COALESCE on suspend so re-suspending an already-
 * suspended org is idempotent on the timestamp (the original freeze time
 * is preserved) while still refreshing the operator note. Reactivate
 * clears both columns unconditionally.
 *
 * 404 semantics mirror the detail service: a missing org → NotFoundException
 * `tenant_not_found`. The audit row is STILL written (audit-first), so the
 * access attempt against a non-existent id is forensically recorded.
 *
 * NOT in scope (D.49): destructive/irreversible actions (purge). This
 * service only toggles a reversible operational flag.
 */
import { organizations, withProvider } from '@emapp/db';
import type { TenantSuspensionState } from '@emapp/shared-types';
import { Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { flushSessionCache } from '../auth/session-validity';
import { revokeAllForOrg, revokeTenantSessionsForOrg } from '../auth/session.repository';

import type { ProviderActor } from './current-provider.decorator';

type SuspensionRow = {
  id: string;
  suspendedAt: Date | null;
  suspendedReason: string | null;
};

@Injectable()
export class ProviderTenantSuspensionService {
  async suspend(
    actor: ProviderActor,
    reason: string,
    tenantId: string,
    note: string | null,
  ): Promise<TenantSuspensionState> {
    const row = await withProvider(
      actor.sub,
      reason,
      async (tx) => {
        const rows = await tx
          .update(organizations)
          .set({
            // Idempotent: keep the ORIGINAL freeze time on re-suspend.
            suspendedAt: sql`COALESCE(${organizations.suspendedAt}, now())`,
            suspendedReason: note,
            updatedAt: sql`now()`,
          })
          .where(eq(organizations.id, tenantId))
          .returning({
            id: organizations.id,
            suspendedAt: organizations.suspendedAt,
            suspendedReason: organizations.suspendedReason,
          });
        const updated = (rows[0] as SuspensionRow | undefined) ?? null;
        // D.49 enforcement: when the org is really suspended, freeze BOTH tiers
        // IN THE SAME audited work tx — org users (auth_sessions) AND residents
        // (tenant_sessions). An already-authenticated user/resident is locked
        // out (refresh re-checks revoked_at; the access token dies via
        // isOrgSessionActive after the cache flush below; resident OTP verify is
        // blocked by isOrgSuspended). Skipped on a 404 (no row).
        if (updated) {
          await revokeAllForOrg(tx, tenantId);
          await revokeTenantSessionsForOrg(tx, tenantId);
        }
        return updated;
      },
      {
        ip: actor.ip,
        userAgent: actor.userAgent,
        targetTable: 'organizations',
        targetRecordId: tenantId,
        action: 'provider.tenant.suspended',
        metadata: { endpoint: 'suspend', tenantId },
      },
    );

    // Clear the in-process session-active cache so the revocation above is
    // effective IMMEDIATELY on this instance (other instances converge within
    // the 15s TTL). Same pattern as the refresh-reuse purge in auth.service.
    if (row) flushSessionCache();

    return this.toState(row, tenantId, true);
  }

  async reactivate(
    actor: ProviderActor,
    reason: string,
    tenantId: string,
  ): Promise<TenantSuspensionState> {
    // Reactivate only clears the suspension flag → NEW logins succeed again.
    // It deliberately does NOT un-revoke the sessions killed at suspend time:
    // once a session is revoked it stays dead (re-login required) — the safe
    // direction, and consistent with logout/reuse-purge semantics.
    const row = await withProvider(
      actor.sub,
      reason,
      async (tx) => {
        const rows = await tx
          .update(organizations)
          .set({
            suspendedAt: null,
            suspendedReason: null,
            updatedAt: sql`now()`,
          })
          .where(eq(organizations.id, tenantId))
          .returning({
            id: organizations.id,
            suspendedAt: organizations.suspendedAt,
            suspendedReason: organizations.suspendedReason,
          });
        return (rows[0] as SuspensionRow | undefined) ?? null;
      },
      {
        ip: actor.ip,
        userAgent: actor.userAgent,
        targetTable: 'organizations',
        targetRecordId: tenantId,
        action: 'provider.tenant.reactivated',
        metadata: { endpoint: 'reactivate', tenantId },
      },
    );

    return this.toState(row, tenantId, false);
  }

  private toState(
    row: SuspensionRow | null,
    tenantId: string,
    suspended: boolean,
  ): TenantSuspensionState {
    if (!row) {
      throw new NotFoundException({
        error: {
          code: 'tenant_not_found',
          message: `No tenant found for id`,
        },
      });
    }
    return {
      id: row.id,
      suspended,
      suspendedAt: row.suspendedAt,
      suspendedReason: row.suspendedReason,
    };
  }
}
