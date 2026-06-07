/**
 * Access-tracking spec for ContractorAuthGuard.canActivate — verifies the
 * best-effort `shares.last_accessed_at` write added to the guard.
 *
 * Contract under test (contractor-auth.guard.ts):
 *   - A valid contractor request → canActivate true AND last_accessed_at is
 *     SET (was null).
 *   - THROTTLE (LAST_ACCESS_THROTTLE_MS = 5 min): an immediate second request
 *     does NOT re-write the timestamp; once the row is forced stale (>5 min)
 *     the next request refreshes it.
 *   - Access-tracking does NOT change auth: a REVOKED share → 401 AND the row
 *     is NOT touched (auth-leak guard). A SUSPENDED org → 401.
 *   - Cross-org safety: the update is scoped WHERE id = shareId — a second
 *     org's share row stays null.
 *
 * All last_accessed_at reads/writes go through providerPool (BYPASSRLS) so the
 * assertions observe the raw row independent of the guard's own RLS tx.
 */
import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import { contractors, defaultSharePermissions, shares, withTenant } from '@emapp/db';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import { ContractorAuthGuard } from './contractor-auth.guard';
import { ShareTokenService } from './share-token.service';

let jwt: JwtService;
let tokenSvc: ShareTokenService;
let guard: ContractorAuthGuard;

let orgA: TestOrg;
let shareIdA = '';
let contractorIdA = '';
let projectIdA = '';

let orgB: TestOrg;
let shareIdB = '';

function mockCtx(token: string): {
  switchToHttp: () => { getRequest: () => Record<string, unknown> };
} {
  const req: Record<string, unknown> = {
    cookies: {},
    headers: { authorization: `Bearer ${token}` },
  };
  return { switchToHttp: () => ({ getRequest: () => req }) };
}

/** Read raw last_accessed_at for a share via BYPASSRLS pool. */
async function readLastAccess(shareId: string): Promise<Date | null> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ last_accessed_at: Date | null }>(
      `SELECT last_accessed_at FROM shares WHERE id = $1`,
      [shareId],
    );
    return r.rows[0]?.last_accessed_at ?? null;
  } finally {
    c.release();
  }
}

/** Force last_accessed_at to N ms in the past (via BYPASSRLS pool). */
async function setLastAccessAgo(shareId: string, ms: number): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE shares SET last_accessed_at = now() - ($2::int * interval '1 ms') WHERE id = $1`,
      [shareId, ms],
    );
  } finally {
    c.release();
  }
}

async function setLastAccessNull(shareId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(`UPDATE shares SET last_accessed_at = NULL WHERE id = $1`, [shareId]);
  } finally {
    c.release();
  }
}

async function setShareRevoked(shareId: string, revoked: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(`UPDATE shares SET revoked_at = ${revoked ? 'now()' : 'NULL'} WHERE id = $1`, [
      shareId,
    ]);
  } finally {
    c.release();
  }
}

async function setOrgSuspended(orgId: string, suspended: boolean): Promise<void> {
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

async function seedShare(
  org: TestOrg,
): Promise<{ shareId: string; contractorId: string; projectId: string }> {
  const projectId = org.projects[0]!.id;
  let shareId = '';
  let contractorId = '';
  await withTenant(org.id, async (tx) => {
    const [c] = await tx
      .insert(contractors)
      .values({
        orgId: org.id,
        name: 'AccessCo',
        contactEmail: `ac-${randomUUID()}@test.local`,
        createdBy: org.users[0]!.id,
      })
      .returning({ id: contractors.id });
    contractorId = c!.id;
    const [s] = await tx
      .insert(shares)
      .values({
        projectId,
        contractorId,
        permissions: defaultSharePermissions(),
        createdBy: org.users[0]!.id,
      })
      .returning({ id: shares.id });
    shareId = s!.id;
  });
  return { shareId, contractorId, projectId };
}

beforeAll(async () => {
  await setupTestDatabase();
  jwt = new JwtService({ secret: serverEnv.JWT_SECRET });
  tokenSvc = new ShareTokenService(jwt);
  guard = new ContractorAuthGuard(tokenSvc);

  const stampA = `la-a-${Date.now()}`;
  orgA = await createTestOrg(stampA, stampA);
  const seedA = await seedShare(orgA);
  shareIdA = seedA.shareId;
  contractorIdA = seedA.contractorId;
  projectIdA = seedA.projectId;

  const stampB = `la-b-${Date.now()}`;
  orgB = await createTestOrg(stampB, stampB);
  const seedB = await seedShare(orgB);
  shareIdB = seedB.shareId;

  // Belt-and-suspenders: ensure both rows start null.
  await setLastAccessNull(shareIdA);
  await setLastAccessNull(shareIdB);
}, 90_000);

afterAll(async () => {
  await setShareRevoked(shareIdA, false);
  await setOrgSuspended(orgA.id, false);
});

function tokenA(): string {
  return tokenSvc.sign({
    sub: contractorIdA,
    projectId: projectIdA,
    shareId: shareIdA,
    orgId: orgA.id,
  }).token;
}

describe('ContractorAuthGuard — last_accessed_at access tracking', () => {
  it('valid request → returns true AND sets last_accessed_at (was null)', async () => {
    await setLastAccessNull(shareIdA);
    expect(await readLastAccess(shareIdA)).toBeNull();

    const before = Date.now();
    const ok = await guard.canActivate(mockCtx(tokenA()) as never);
    const after = Date.now();
    expect(ok).toBe(true);

    const stamp = await readLastAccess(shareIdA);
    expect(stamp).not.toBeNull();
    // Written ~now() — allow generous skew (clock vs DB now()).
    const t = stamp!.getTime();
    expect(t).toBeGreaterThanOrEqual(before - 5_000);
    expect(t).toBeLessThanOrEqual(after + 5_000);
  });

  it('THROTTLE: an immediate second request does NOT re-write the timestamp', async () => {
    // Seed a fresh "just now" timestamp so the next request is well within 5 min.
    await setLastAccessAgo(shareIdA, 1_000); // 1s ago
    const first = await readLastAccess(shareIdA);
    expect(first).not.toBeNull();

    const ok = await guard.canActivate(mockCtx(tokenA()) as never);
    expect(ok).toBe(true);

    const second = await readLastAccess(shareIdA);
    expect(second!.getTime()).toBe(first!.getTime());
  });

  it('STALE (>5 min): the next request refreshes last_accessed_at (newer)', async () => {
    await setLastAccessAgo(shareIdA, 10 * 60 * 1000); // 10 min ago
    const stale = await readLastAccess(shareIdA);
    expect(stale).not.toBeNull();

    const ok = await guard.canActivate(mockCtx(tokenA()) as never);
    expect(ok).toBe(true);

    const refreshed = await readLastAccess(shareIdA);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.getTime()).toBeGreaterThan(stale!.getTime());
  });

  it('REVOKED share → 401 AND last_accessed_at is NOT written (auth-leak guard)', async () => {
    await setLastAccessNull(shareIdA);
    await setShareRevoked(shareIdA, true);

    await expect(guard.canActivate(mockCtx(tokenA()) as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // The revoked row is filtered out (isNull(revokedAt)) BEFORE the update —
    // a written timestamp here would be an access-leak on a revoked share.
    expect(await readLastAccess(shareIdA)).toBeNull();

    await setShareRevoked(shareIdA, false);
  });

  it('SUSPENDED org → 401 AND last_accessed_at is NOT written', async () => {
    await setLastAccessNull(shareIdA);
    await setOrgSuspended(orgA.id, true);

    await expect(guard.canActivate(mockCtx(tokenA()) as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(await readLastAccess(shareIdA)).toBeNull();

    await setOrgSuspended(orgA.id, false);
  });

  it('CROSS-ORG: the update touches ONLY this share — org B share stays null', async () => {
    await setLastAccessNull(shareIdA);
    await setLastAccessNull(shareIdB);

    const ok = await guard.canActivate(mockCtx(tokenA()) as never);
    expect(ok).toBe(true);

    // org A written, org B untouched.
    expect(await readLastAccess(shareIdA)).not.toBeNull();
    expect(await readLastAccess(shareIdB)).toBeNull();
  });

  it('best-effort: the happy path still returns true after tracking runs', async () => {
    await setLastAccessNull(shareIdA);
    const ok = await guard.canActivate(mockCtx(tokenA()) as never);
    expect(ok).toBe(true);
  });
});
