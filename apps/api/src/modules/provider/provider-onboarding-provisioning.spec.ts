/**
 * RED regression — the IAM assignment-provisioning gap on the PROVIDER
 * ONBOARDING path (sibling of `auth/iam-provisioning.spec.ts`).
 *
 * THE GAP: authorization is engine-backed — the AuthorizationGuard resolves
 * permissions from `role_assignments ⋈ role_permissions`. A user with NO
 * covering `role_assignments` row resolves to ZERO permissions → 403 (default
 * deny). `ProviderOnboardingService.onboard` creates a fresh org + a first
 * `manager` membership but NO `role_assignments` row, so the onboarded manager
 * is locked out of their own org the moment they accept the invite. The org's
 * founding user is its OWNER (decision §11.1 / D-A, same as self-signup), so the
 * engine MUST resolve the OWNER effective set for them.
 *
 * ANTI-BIAS: this file NEVER inserts a `role_assignments` row. The only way an
 * assignment can exist is as a SIDE EFFECT of the real `onboard()` call. Every
 * assertion resolves through `PermissionService.effectivePermissions(...)`
 * inside `withTenant` — the same path the guard + `/me` use. The expected set is
 * an independent oracle over `SYSTEM_ROLES` + the implication closure (it reads
 * the code catalog only; it never seeds the DB).
 *
 * FAILS NOW because the resolved set is EMPTY (onboard wrote no assignment) —
 * not a setup error.
 */
import { serverEnv } from '@emapp/config';
import { FakeEmailProvider, withTenant } from '@emapp/db';
import { JwtService } from '@nestjs/jwt';
import { beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import {
  createTestProviderUser,
  type TestProviderUser,
} from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import {
  PermissionResolutionCache,
  PermissionService,
} from '../../common/authz/permission.service';
import { PERMISSION_IMPLICATIONS, type Permission } from '../../common/authz/permissions';
import { SYSTEM_ROLES, type SystemRoleKey } from '../../common/authz/system-roles';

import type { ProviderPrincipal } from './current-provider.decorator';
import { ProviderOnboardingService } from './provider-onboarding.service';

let provider: TestProviderUser;
let svc: ProviderOnboardingService;
const permissions = new PermissionService();
const PREFIX = 'prov-onb-prov-' + Date.now();

function principal(): ProviderPrincipal {
  return {
    sub: provider.id,
    ip: '203.0.113.99',
    userAgent: 'prov-onboarding-provisioning-spec/1.0',
  };
}

/** Independent oracle: a system role's effective set with the §2 closure expanded. */
function expectedEffectiveSorted(key: SystemRoleKey): string[] {
  const def = SYSTEM_ROLES.find((r) => r.key === key)!;
  const out = new Set<Permission>(def.permissions);
  const stack = [...def.permissions];
  while (stack.length > 0) {
    const perm = stack.pop()!;
    for (const parent of PERMISSION_IMPLICATIONS.get(perm) ?? []) {
      if (!out.has(parent)) {
        out.add(parent);
        stack.push(parent);
      }
    }
  }
  return [...out].sort();
}

/** Resolve a user's effective org-scope permissions THROUGH THE ENGINE (read-only). */
async function resolveOrgPermissions(userId: string, orgId: string): Promise<string[]> {
  const effective = await withTenant(orgId, async (tx) => {
    const cache = new PermissionResolutionCache();
    return permissions.effectivePermissions(
      { id: userId, orgId },
      { type: 'org', id: orgId },
      tx,
      cache,
    );
  });
  return [...effective].sort();
}

/** Look up the onboarded user's id by email via the provider pool (BYPASSRLS). */
async function userIdByEmail(email: string): Promise<string | undefined> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    return r.rows[0]?.id;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  provider = await createTestProviderUser();
  svc = new ProviderOnboardingService(
    new JwtService({ secret: serverEnv.JWT_SECRET }),
    new FakeEmailProvider(),
  );
}, 90_000);

describe('IAM provisioning gap — provider onboarding must grant the founding Owner assignment', () => {
  it('onboard → the onboarded manager resolves to the OWNER effective set (currently EMPTY)', async () => {
    const managerEmail = `${PREFIX}-mgr@example.test`;
    const result = await svc.onboard(principal(), 'provisioning-gap: onboard pilot org', {
      orgName: 'Provisioning Gap Renewal Co',
      managerName: 'דנה מנהלת',
      managerEmail,
    });

    const userId = await userIdByEmail(managerEmail);
    expect(userId, 'onboarded user not found').toBeTruthy();

    const resolved = await resolveOrgPermissions(userId!, result.orgId);

    // The gap: this is [] today because onboard wrote no role_assignment.
    expect(
      resolved.length,
      'onboard created no role_assignment → the founding manager has ZERO permissions',
    ).toBeGreaterThan(0);
    expect(resolved).toEqual(expectedEffectiveSorted('owner'));
    // Owner-exclusive proof (not a Manager false-positive).
    expect(resolved).toContain('org.transfer_ownership');
    expect(resolved).toContain('org.delete');
  }, 60_000);
});
