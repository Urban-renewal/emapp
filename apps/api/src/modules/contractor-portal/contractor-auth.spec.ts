/**
 * D2-DEF-1 — share-token + ContractorAuthGuard security spec.
 *
 *   - Token: sign→verify round-trip; AUDIENCE ISOLATION (an `emapp-api`
 *     token does NOT pass the share verify, and vice-versa); tampered/
 *     malformed → generic invalid_token.
 *   - Guard: a valid token on an active share → allows + attaches the live
 *     perms; a REVOKED share → 401; a SUSPENDED org → 401; missing token →
 *     missing_token. All failure codes are generic (no oracle).
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

import { ContractorAuthGuard, type ContractorContext } from './contractor-auth.guard';
import { ShareTokenService } from './share-token.service';

let jwt: JwtService;
let tokenSvc: ShareTokenService;
let guard: ContractorAuthGuard;
let orgA: TestOrg;
let shareId = '';
let contractorId = '';
let projectId = '';

function mockCtx(token?: string): {
  switchToHttp: () => { getRequest: () => Record<string, unknown> };
} {
  const req: Record<string, unknown> = {
    cookies: token ? { contractor_access_token: token } : {},
    headers: {},
  };
  return { switchToHttp: () => ({ getRequest: () => req }) };
}

async function setShareRevoked(revoked: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(`UPDATE shares SET revoked_at = ${revoked ? 'now()' : 'NULL'} WHERE id = $1`, [
      shareId,
    ]);
  } finally {
    c.release();
  }
}
async function setOrgSuspended(suspended: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE organizations SET suspended_at = ${suspended ? 'now()' : 'NULL'} WHERE id = $1`,
      [orgA.id],
    );
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  jwt = new JwtService({ secret: serverEnv.JWT_SECRET });
  tokenSvc = new ShareTokenService(jwt);
  guard = new ContractorAuthGuard(tokenSvc);
  orgA = await createTestOrg(`def1g-${Date.now()}`, `def1g-${Date.now()}`);
  projectId = orgA.projects[0]!.id;
  await withTenant(orgA.id, async (tx) => {
    const [c] = await tx
      .insert(contractors)
      .values({
        orgId: orgA.id,
        name: 'GuardCo',
        contactEmail: `gc-${randomUUID()}@test.local`,
        createdBy: orgA.users[0]!.id,
      })
      .returning({ id: contractors.id });
    contractorId = c!.id;
    const [s] = await tx
      .insert(shares)
      .values({
        projectId,
        contractorId,
        permissions: defaultSharePermissions(),
        createdBy: orgA.users[0]!.id,
      })
      .returning({ id: shares.id });
    shareId = s!.id;
  });
}, 90_000);

afterAll(async () => {
  await setOrgSuspended(false);
  await setShareRevoked(false);
});

function freshToken(): string {
  return tokenSvc.sign({ sub: contractorId, projectId, shareId, orgId: orgA.id }).token;
}

describe('ShareTokenService — sign/verify + audience isolation', () => {
  it('round-trips a valid token', () => {
    const v = tokenSvc.verify(freshToken());
    expect(v.sub).toBe(contractorId);
    expect(v.shareId).toBe(shareId);
    expect(v.orgId).toBe(orgA.id);
  });

  it('rejects a token minted for a DIFFERENT audience (emapp-api) — no token confusion', () => {
    const orgToken = jwt.sign(
      { sub: contractorId, projectId, shareId, orgId: orgA.id },
      { secret: serverEnv.JWT_SECRET, algorithm: 'HS256', issuer: 'emapp', audience: 'emapp-api' },
    );
    expect(() => tokenSvc.verify(orgToken)).toThrow(UnauthorizedException);
  });

  it('rejects a tampered / malformed token (generic invalid_token)', () => {
    expect(() => tokenSvc.verify('not.a.jwt')).toThrow(UnauthorizedException);
    expect(() => tokenSvc.verify(freshToken() + 'x')).toThrow(UnauthorizedException);
  });
});

describe('ContractorAuthGuard', () => {
  it('valid token on an active share → allows + attaches live perms', async () => {
    await setShareRevoked(false);
    await setOrgSuspended(false);
    const req = mockCtx(freshToken()).switchToHttp().getRequest();
    const ok = await guard.canActivate(mockCtx(freshToken()) as never);
    expect(ok).toBe(true);
    // canActivate attaches req.contractor on the SAME req it read — re-run
    // against a captured req to assert the attachment shape.
    const captured: Record<string, unknown> = {
      cookies: { contractor_access_token: freshToken() },
      headers: {},
    };
    await guard.canActivate({
      switchToHttp: () => ({ getRequest: () => captured }),
    } as never);
    const ctx = captured['contractor'] as ContractorContext;
    expect(ctx.contractorId).toBe(contractorId);
    expect(ctx.permissions.overview.on).toBe(true);
    void req;
  });

  it('missing token → 401 missing_token', async () => {
    await expect(guard.canActivate(mockCtx(undefined) as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('REVOKED share → 401 (revocation is immediate)', async () => {
    await setShareRevoked(true);
    await expect(guard.canActivate(mockCtx(freshToken()) as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await setShareRevoked(false);
  });

  it('SUSPENDED org → 401 (contractor reads inert, D.49)', async () => {
    await setOrgSuspended(true);
    await expect(guard.canActivate(mockCtx(freshToken()) as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await setOrgSuspended(false);
  });
});

/**
 * SECURITY — share EXPIRY enforced on RETRIEVAL (red-team blocker).
 *
 * A long-lived share JWT must NOT outlive the share's intended lifetime: an
 * expired / over-TTL credential is refused on EVERY contractor read/download
 * (the guard is the single chokepoint for `/contractor/*`), fail-closed and
 * with the same generic 401 as a revoked/forged token (no oracle). The guard
 * re-asserts `exp` explicitly, independent of the verify path.
 */
describe('ContractorAuthGuard — share expiry on retrieval', () => {
  /** Mint a share-token with a caller-chosen `exp` (valid sig/aud/iss). Used to
   *  forge an OVER-TTL credential whose only defect is a past `exp`. */
  function tokenWithExp(expSeconds: number): string {
    const nowSec = Math.floor(Date.now() / 1000);
    // Explicit iat + exp in the payload (NO `expiresIn` option, so @nestjs/jwt
    // honors our `exp` verbatim). `verify()` requires both as numbers — keep iat.
    // SHARE_TOKEN_SECRET falls back to JWT_SECRET in test (single-secret).
    return jwt.sign(
      { sub: contractorId, projectId, shareId, orgId: orgA.id, iat: nowSec, exp: expSeconds },
      {
        secret: serverEnv.SHARE_TOKEN_SECRET ?? serverEnv.JWT_SECRET,
        algorithm: 'HS256',
        issuer: 'emapp',
        audience: 'emapp-share',
      },
    );
  }

  it('an EXPIRED / over-TTL share → 401 on document retrieval (no-oracle)', async () => {
    await setShareRevoked(false);
    await setOrgSuspended(false);
    // exp 1 hour in the PAST — share row is active, but the credential's
    // lifetime has passed → retrieval is refused.
    const expired = tokenWithExp(Math.floor(Date.now() / 1000) - 3600);
    await expect(guard.canActivate(mockCtx(expired) as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('the guard RE-ASSERTS exp even when verify() returns a stale token (defense-in-depth)', async () => {
    await setShareRevoked(false);
    await setOrgSuspended(false);
    // Simulate a verify path that does NOT reject an aged token (e.g. a future
    // refactor / a replayed payload): the guard's own retrieval-time exp gate
    // must still refuse. Proves the gate is independent of verify().
    const staleVerify = {
      verify: () => ({
        sub: contractorId,
        projectId,
        shareId,
        orgId: orgA.id,
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 3600,
      }),
    } as unknown as ShareTokenService;
    const guardWithStaleVerify = new ContractorAuthGuard(staleVerify);
    await expect(
      guardWithStaleVerify.canActivate(mockCtx('any.token.value') as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a REVOKED share → 401 on retrieval (not just on listing)', async () => {
    await setShareRevoked(true);
    // A still-in-window token (valid exp) on a revoked share is refused at the
    // retrieval chokepoint — every `/contractor/*` read goes through this guard.
    await expect(guard.canActivate(mockCtx(freshToken()) as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await setShareRevoked(false);
  });

  it('a VALID in-window share → allows (200 path)', async () => {
    await setShareRevoked(false);
    await setOrgSuspended(false);
    // exp 1 hour in the FUTURE, active + non-suspended → guard allows.
    const future = tokenWithExp(Math.floor(Date.now() / 1000) + 3600);
    await expect(guard.canActivate(mockCtx(future) as never)).resolves.toBe(true);
  });
});
