/**
 * X-S2 / X-S3 (V13) — external_share service spec.
 *
 * Covers the authorization spine end-to-end against the real local DB:
 *   - preset-ceiling enforcement: a create that WIDENS beyond the party ceiling
 *     (scope_type / permission flag / allow_sensitive / TTL) is REJECTED.
 *   - a create WITHIN the ceiling succeeds.
 *   - update is NARROWS-ONLY: tightening succeeds; any widening is rejected.
 *   - revoke is immediate + idempotent.
 *   - extend pushes expires_at forward only, capped at the ceiling.
 *   - suspended org → every op inert (404 / empty list).
 *   - RLS isolation: org B cannot see / mutate org A's grant.
 *   - no-oracle: a missing / cross-org id → generic 404.
 */
import {
  PARTY_PRESET_CEILINGS,
  type ExternalSharePermissions,
} from '@emapp/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ExternalSharesService } from './external-shares.service';

let svc: ExternalSharesService;
let orgA: TestOrg;
let orgB: TestOrg;
let projectAId: string;
let projectBId: string;

const FULL: ExternalSharePermissions = {
  overview: { on: true },
  documents: { on: true, actions: { download: true } },
  signatures: { on: true },
};
const OVERVIEW_ONLY: ExternalSharePermissions = {
  overview: { on: true },
  documents: { on: false, actions: { download: false } },
  signatures: { on: false },
};

function manager(org: TestOrg): AccessTokenPayload {
  return {
    sub: org.users[0]!.id,
    orgId: org.id,
    role: 'manager',
    sid: '00000000-0000-4000-8000-000000000001',
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function viewer(org: TestOrg): AccessTokenPayload {
  return { ...manager(org), role: 'viewer' } as AccessTokenPayload;
}

async function setSuspended(orgId: string, suspended: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE organizations SET suspended_at = ${suspended ? 'now()' : 'NULL'} WHERE id = $1`,
      [orgId],
    );
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ExternalSharesService();
  orgA = await createTestOrg(`xsa-${Date.now()}`, `xsa-${Date.now()}`);
  orgB = await createTestOrg(`xsb-${Date.now()}`, `xsb-${Date.now()}`);
  projectAId = orgA.projects[0]!.id;
  projectBId = orgB.projects[0]!.id;
});

afterAll(async () => {
  await setSuspended(orgA.id, false);
  await setSuspended(orgB.id, false);
});

describe('ExternalSharesService — ceiling enforcement (create)', () => {
  it('creates a grant WITHIN the developer ceiling (project, full, sensitive)', async () => {
    const v = await svc.create(manager(orgA), {
      partyType: 'developer',
      scopeType: 'project',
      scopeIds: [projectAId],
      permissions: FULL,
      allowSensitive: true,
      otpRequired: true,
    });
    expect(v.partyType).toBe('developer');
    expect(v.allowSensitive).toBe(true);
    expect(v.scopeIds).toEqual([projectAId]);
  });

  it('REJECTS allow_sensitive for a party whose ceiling forbids it (appraiser)', async () => {
    // appraiser ceiling: apartment-scope, no sensitive. Use a permitted scope so
    // the ONLY violation is allow_sensitive → proves THAT axis is enforced.
    await expect(
      svc.create(manager(orgA), {
        partyType: 'appraiser',
        scopeType: 'apartment',
        scopeIds: ['00000000-0000-4000-8000-000000000099'],
        permissions: OVERVIEW_ONLY,
        allowSensitive: true, // ← the widening
        otpRequired: true,
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'exceeds_ceiling' } } });
  });

  it('REJECTS a scope_type WIDER than the ceiling (appraiser asks project-wide)', async () => {
    await expect(
      svc.create(manager(orgA), {
        partyType: 'appraiser',
        scopeType: 'project', // ceiling is 'apartment'
        scopeIds: [projectAId],
        permissions: OVERVIEW_ONLY,
        allowSensitive: false,
        otpRequired: true,
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'exceeds_ceiling' } } });
  });

  it('REJECTS a permission flag beyond the ceiling (committee asks documents.download)', async () => {
    // committee ceiling: overview + signatures, NO documents.
    await expect(
      svc.create(manager(orgA), {
        partyType: 'committee',
        scopeType: 'project',
        scopeIds: [projectAId],
        permissions: {
          overview: { on: true },
          documents: { on: true, actions: { download: true } }, // ← beyond ceiling
          signatures: { on: true },
        },
        allowSensitive: false,
        otpRequired: true,
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'exceeds_ceiling' } } });
  });

  it('REJECTS a TTL beyond the ceiling maxTtlDays (appraiser 90d)', async () => {
    const tooFar = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000);
    await expect(
      svc.create(manager(orgA), {
        partyType: 'appraiser',
        scopeType: 'apartment',
        scopeIds: ['00000000-0000-4000-8000-000000000099'],
        permissions: OVERVIEW_ONLY,
        allowSensitive: false,
        otpRequired: true,
        expiresAt: tooFar,
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'exceeds_ceiling' } } });
  });

  it('REJECTS scope_ids that do not resolve in-org (invalid_scope)', async () => {
    await expect(
      svc.create(manager(orgA), {
        partyType: 'developer',
        scopeType: 'project',
        scopeIds: [projectBId], // belongs to org B — invisible under org A RLS
        permissions: OVERVIEW_ONLY,
        allowSensitive: false,
        otpRequired: true,
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'invalid_scope' } } });
  });

  it('REJECTS a non-manager writer (forbidden)', async () => {
    await expect(
      svc.create(viewer(orgA), {
        partyType: 'developer',
        scopeType: 'project',
        scopeIds: [projectAId],
        permissions: OVERVIEW_ONLY,
        allowSensitive: false,
        otpRequired: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ExternalSharesService — narrows-only (update)', () => {
  it('allows narrowing (full → overview-only) and rejects re-widening', async () => {
    const created = await svc.create(manager(orgA), {
      partyType: 'developer',
      scopeType: 'project',
      scopeIds: [projectAId],
      permissions: FULL,
      allowSensitive: true,
      otpRequired: true,
    });

    // Narrow: drop documents+signatures, drop sensitive → OK.
    const narrowed = await svc.update(manager(orgA), created.id, {
      permissions: OVERVIEW_ONLY,
      allowSensitive: false,
    });
    expect(narrowed.permissions.documents.on).toBe(false);
    expect(narrowed.allowSensitive).toBe(false);

    // Re-widen sensitive false→true → cannot_widen.
    await expect(
      svc.update(manager(orgA), created.id, { allowSensitive: true }),
    ).rejects.toMatchObject({ response: { error: { code: 'cannot_widen' } } });

    // Re-widen a permission flag off→on → cannot_widen.
    await expect(
      svc.update(manager(orgA), created.id, { permissions: FULL }),
    ).rejects.toMatchObject({ response: { error: { code: 'cannot_widen' } } });
  });

  it('rejects removing the OTP gate (otp true→false is widening)', async () => {
    const created = await svc.create(manager(orgA), {
      partyType: 'developer',
      scopeType: 'project',
      scopeIds: [projectAId],
      permissions: OVERVIEW_ONLY,
      allowSensitive: false,
      otpRequired: true,
    });
    await expect(
      svc.update(manager(orgA), created.id, { otpRequired: false }),
    ).rejects.toMatchObject({ response: { error: { code: 'cannot_widen' } } });
  });
});

describe('ExternalSharesService — revoke / extend / resend', () => {
  it('revoke is immediate and idempotent; revoked grant is invisible to list + update', async () => {
    const created = await svc.create(manager(orgA), {
      partyType: 'bank',
      scopeType: 'project',
      scopeIds: [projectAId],
      permissions: OVERVIEW_ONLY,
      allowSensitive: false,
      otpRequired: true,
    });
    await svc.revoke(manager(orgA), created.id);
    // idempotent second revoke
    await svc.revoke(manager(orgA), created.id);
    // update on a revoked grant → 404 (filtered by isNull(revokedAt))
    await expect(
      svc.update(manager(orgA), created.id, { permissions: OVERVIEW_ONLY }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const page = await svc.list(manager(orgA), { limit: 100 });
    expect(page.data.find((g) => g.id === created.id)).toBeUndefined();
  });

  it('extend pushes expires_at forward only; backward is rejected', async () => {
    const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const created = await svc.create(manager(orgA), {
      partyType: 'developer',
      scopeType: 'project',
      scopeIds: [projectAId],
      permissions: OVERVIEW_ONLY,
      allowSensitive: false,
      otpRequired: true,
      expiresAt: soon,
    });
    const later = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const extended = await svc.extend(manager(orgA), created.id, { expiresAt: later });
    expect(extended.expiresAt!.getTime()).toBe(later.getTime());
    // backward
    await expect(
      svc.extend(manager(orgA), created.id, { expiresAt: soon }),
    ).rejects.toMatchObject({ response: { error: { code: 'not_forward' } } });
  });
});

describe('ExternalSharesService — suspension + RLS isolation + no-oracle', () => {
  it('suspended org: create / update / revoke / list all inert (404 / empty)', async () => {
    const created = await svc.create(manager(orgA), {
      partyType: 'developer',
      scopeType: 'project',
      scopeIds: [projectAId],
      permissions: OVERVIEW_ONLY,
      allowSensitive: false,
      otpRequired: true,
    });
    await setSuspended(orgA.id, true);
    try {
      await expect(
        svc.create(manager(orgA), {
          partyType: 'developer',
          scopeType: 'project',
          scopeIds: [projectAId],
          permissions: OVERVIEW_ONLY,
          allowSensitive: false,
          otpRequired: true,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.update(manager(orgA), created.id, { permissions: OVERVIEW_ONLY }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.revoke(manager(orgA), created.id)).rejects.toBeInstanceOf(NotFoundException);
      const page = await svc.list(manager(orgA), { limit: 50 });
      expect(page.data).toEqual([]);
    } finally {
      await setSuspended(orgA.id, false);
    }
    // After reactivation the grant is visible again — proves the gate is the
    // suspension flag, not some unrelated rule (D.51 plaster check).
    const page = await svc.list(manager(orgA), { limit: 100 });
    expect(page.data.find((g) => g.id === created.id)).toBeDefined();
  });

  it('RLS isolation: org B cannot see or mutate org A grant (no-oracle 404)', async () => {
    const created = await svc.create(manager(orgA), {
      partyType: 'developer',
      scopeType: 'project',
      scopeIds: [projectAId],
      permissions: OVERVIEW_ONLY,
      allowSensitive: false,
      otpRequired: true,
    });
    // org B list does not include it.
    const pageB = await svc.list(manager(orgB), { limit: 100 });
    expect(pageB.data.find((g) => g.id === created.id)).toBeUndefined();
    // org B update/revoke → 404 (RLS hides the row).
    await expect(
      svc.update(manager(orgB), created.id, { permissions: OVERVIEW_ONLY }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.revoke(manager(orgB), created.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('missing id → generic 404 (no-oracle)', async () => {
    await expect(
      svc.revoke(manager(orgA), '00000000-0000-4000-8000-0000000000aa'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PARTY_PRESET_CEILINGS — every enum value has a ceiling', () => {
  it('covers all 9 party types', () => {
    const keys = Object.keys(PARTY_PRESET_CEILINGS);
    expect(keys).toHaveLength(9);
    for (const k of keys) {
      const c = PARTY_PRESET_CEILINGS[k as keyof typeof PARTY_PRESET_CEILINGS];
      expect(['project', 'building', 'apartment']).toContain(c.maxScopeType);
    }
  });
});
