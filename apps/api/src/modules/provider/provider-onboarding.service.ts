/**
 * D.45 — Provider-initiated onboarding service.
 *
 * `POST /provider/tenants` — a Provider Admin creates a brand-new Org and
 * invites its first Manager. The manager sets their OWN password via the
 * existing PUBLIC `/auth/accept-invite` flow (ISO A.9.2.1) — the provider
 * never learns it.
 *
 * Why `withProvider` (not `withBootstrap`): this is a cross-tenant
 * PROVIDER write, so it MUST run through the audit-first path (D.49) —
 * the `provider_audit_log` row (`provider.tenant.created`) is committed in
 * an autonomous tx BEFORE the work runs (SA-7). The org + first-manager
 * user + pending membership are inserted inside the single work tx
 * (provider pool = BYPASSRLS, so the chicken-and-egg users↔membership RLS
 * dependency doesn't apply — same reason signup uses a bypass path).
 *
 * The invite token (HS256, iss=emapp / aud=emapp-invite, 7d) is signed and
 * the email sent AFTER the tx commits — a transient mail failure must not
 * roll back (or 500) a committed org; the provider can re-onboard / the
 * manager can be re-invited. The token is a credential: never logged.
 *
 * No new PII surface: org/user/manager names are not encrypted columns;
 * `national_id` is never touched here. The audit row carries NO email —
 * only `{ orgId, slug }` (ISO A.12.4 — log the action, not the PII).
 */
import { randomUUID } from 'node:crypto';

import {
  organizations,
  memberships,
  roleAssignments,
  roles,
  users,
  withProvider,
  type IEmailProvider,
} from '@emapp/db';
import type { OnboardOrgBody, OnboardOrgResult } from '@emapp/shared-types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull } from 'drizzle-orm';

import { makeSlug } from '../auth/auth.service';
import { EMAIL_PROVIDER, EXPOSE_INVITE_TOKEN, buildInviteEmail } from '../members/invite-email';

import type { ProviderActor } from './current-provider.decorator';

const INVITE_TTL = '7d';
const JWT_ISS = 'emapp';
const INVITE_AUD = 'emapp-invite';

@Injectable()
export class ProviderOnboardingService {
  private readonly logger = new Logger(ProviderOnboardingService.name);

  constructor(
    private readonly jwt: JwtService,
    @Inject(EMAIL_PROVIDER) private readonly email: IEmailProvider,
  ) {}

  async onboard(
    actor: ProviderActor,
    reason: string,
    body: OnboardOrgBody,
  ): Promise<OnboardOrgResult> {
    // Server-generate every id + the slug up-front so the audit row's
    // targetRecordId is the real org id (committed before the work).
    const orgId = randomUUID();
    const slug = makeSlug(body.orgName);
    const now = new Date();

    const { userId, membershipId } = await withProvider(
      actor.sub,
      reason,
      async (tx) => {
        // Reuse an existing user (someone who already manages another org)
        // rather than colliding on the citext-unique email; otherwise
        // create a password-less user the invite will activate.
        const [existing] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, body.managerEmail))
          .limit(1);

        let uid: string;
        if (existing) {
          uid = existing.id;
        } else {
          const [u] = await tx
            .insert(users)
            .values({ email: body.managerEmail, name: body.managerName, passwordHash: null })
            .returning({ id: users.id });
          if (!u) throw new Error('onboarding: user insert returned no row');
          uid = u.id;
        }

        await tx.insert(organizations).values({ id: orgId, name: body.orgName, slug });

        const [m] = await tx
          .insert(memberships)
          .values({
            userId: uid,
            orgId,
            role: 'manager',
            // First manager of a fresh org is its primary contact, UNLESS
            // this is an existing user who already has a primary elsewhere.
            isPrimary: !existing,
            // Provider-initiated: no inviting org-USER (FK is nullable).
            invitedBy: null,
            acceptedAt: null, // pending until the manager accepts
          })
          .returning({ id: memberships.id });
        if (!m) throw new Error('onboarding: membership insert returned no row');

        // IAM provisioning — authorization is engine-backed: the
        // AuthorizationGuard ⋈ PermissionService resolves permissions from
        // `role_assignments`; without a covering row the founding manager has
        // ZERO permissions and is locked out of their own org on accept. The
        // org's founding user is its OWNER (decision §11.1 / D-A / migration
        // 0044 — same as self-signup). We keep `memberships.role = 'manager'`
        // (the legacy field, unchanged) AND grant an org-scope OWNER assignment
        // so the engine resolves the full Owner set. Atomic with the membership
        // (same withProvider tx) — never an onboarded org with a membership but
        // no assignment.
        const [ownerRole] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(and(isNull(roles.orgId), eq(roles.isSystem, true), eq(roles.key, 'owner')))
          .limit(1);
        if (!ownerRole) throw new Error('onboarding: owner system role not found (seed missing)');
        await tx.insert(roleAssignments).values({
          userId: uid,
          roleId: ownerRole.id,
          scopeType: 'org',
          scopeId: orgId,
          // Provider-initiated: no inviting org-USER. `granted_by` references
          // org users (nullable FK, onDelete:set null), so we use null —
          // mirroring `memberships.invitedBy: null` above. (Self-signup uses the
          // new user's own id; here the actor is a provider_user, not an org
          // user, so null is the correct provenance.)
          grantedBy: null,
          grantedAt: now,
        });

        return { userId: uid, membershipId: m.id };
      },
      {
        ip: actor.ip,
        userAgent: actor.userAgent,
        targetTable: 'organizations',
        targetRecordId: orgId,
        action: 'provider.tenant.created',
        // No PII (no email/name) — only the non-sensitive identifiers.
        metadata: { endpoint: 'onboard', orgId, slug },
      },
    );

    // Same invite-token shape the org-tier invite uses → the existing
    // PUBLIC /auth/accept-invite verifies it unchanged. Bound by the
    // (membershipId, userId, orgId) tuple; no email/role in the token.
    const inviteToken = this.jwt.sign(
      { sub: userId, orgId, mid: membershipId, typ: 'invite' },
      { expiresIn: INVITE_TTL, issuer: JWT_ISS, audience: INVITE_AUD, algorithm: 'HS256' },
    );

    // Best-effort delivery — the org is committed; a transient mail failure
    // must not 500. Record the FACT + cause (NEVER the token / link / body).
    //
    // P6 — From DISPLAY name is left on the SYSTEM DEFAULT here (no per-org
    // branding.senderName resolve). This runs in PROVIDER context for a
    // BRAND-NEW org whose `settings` is the default `{}` (senderName='EMAPP'
    // = the default anyway), and there is no clean `withTenant(orgId)` tx in
    // scope — `getOrgSettings` needs a TenantTx. Resolving here would contort
    // the architecture for zero behavior change. Wired send sites (org
    // context): members.service, calendar-email.service.
    try {
      const r = await this.email.send(
        buildInviteEmail({
          to: body.managerEmail,
          name: body.managerName,
          orgName: body.orgName,
          token: inviteToken,
        }),
      );
      if (r.status === 'rejected') {
        this.logger.error(
          `onboarding invite email rejected (membership=${membershipId}): ${r.error ?? 'unknown'}`,
        );
      }
    } catch (mailErr) {
      this.logger.error(
        `onboarding invite email send failed (membership=${membershipId}): ${
          mailErr instanceof Error ? mailErr.message : 'unknown'
        }`,
      );
    }

    return {
      orgId,
      slug,
      orgName: body.orgName,
      managerEmail: body.managerEmail,
      // Token returned ONLY outside production (D.27). In prod, email is
      // the sole channel.
      ...(EXPOSE_INVITE_TOKEN ? { inviteToken } : {}),
    };
  }
}
