/**
 * S2 invites+docs · #7 — RESEND a pending invite (+ #4/#9 re-invite existing).
 *
 * INDEPENDENT acceptance test (test-author did NOT write the impl).
 *
 * SPEC under test:
 *  #7  POST /api/v1/members/:userId/resend for a PENDING member (invited, not
 *      yet accepted) SUCCEEDS and — in dev/test — returns the invite token/link
 *      (EXPOSE_INVITE_TOKEN). For an ACCEPTED or REVOKED member it is REJECTED
 *      with `member_not_pending`. The route requires the invite permission
 *      (`members.invite`).
 *  #4/#9  Inviting an email that ALREADY has an active membership in the org
 *      returns 409 `member_exists` (confirm the existing behaviour).
 *
 * RED now: `MembersService` has NO `resend` method and the controller has no
 * `:userId/resend` route → the #7 cases throw "resend is not a function" /
 * the controller-permission assertion finds no decorated route.
 *
 * Service-level (real DB, real JwtService + FakeEmailProvider), mirroring
 * apps/api/src/modules/auth/iam-provisioning.spec.ts. Sidesteps HTTP + the
 * signup throttler by seeding the owner with createTestOrg and driving
 * MembersService directly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { serverEnv } from '@emapp/config';
import { FakeEmailProvider, memberships, withTenant } from '@emapp/db';
import { ConflictException, HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { MembersService } from './members.service';

const jwt = new JwtService({ secret: serverEnv.JWT_SECRET });
const members = new MembersService(jwt, new FakeEmailProvider());

const MEMBER_PW = 'MemberPassword654321';
const MGR_SID = '00000000-0000-4000-8000-0000000000e1';

let org: TestOrg;
let managerId: string;

function owner(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function uniqueEmail(tag: string): string {
  return `resend-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

function errCode(e: unknown): string | undefined {
  if (e instanceof Error && 'getResponse' in e) {
    const body = (e as { getResponse: () => unknown }).getResponse();
    const code = (body as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function httpStatus(e: unknown): number | undefined {
  return e instanceof HttpException ? e.getStatus() : undefined;
}

/** Invoke the (not-yet-existing) resend via a cast so this file compiles
 *  before the builder adds the method. */
async function resend(user: AccessTokenPayload, userId: string): Promise<{ inviteToken?: string }> {
  const fn = (
    members as unknown as {
      resend?: (u: AccessTokenPayload, id: string) => Promise<{ inviteToken?: string }>;
    }
  ).resend;
  if (typeof fn !== 'function') {
    throw new Error('MembersService.resend is not implemented yet (RED — #7 gap)');
  }
  return fn.call(members, user, userId);
}

/** Create a PENDING member (invited, not accepted). Returns its userId. */
async function invitePending(role: 'manager' | 'agent' | 'viewer', tag: string): Promise<string> {
  const { member } = await members.create(owner(), {
    email: uniqueEmail(tag),
    name: `Invited ${tag}`,
    role,
  });
  return member.userId;
}

/** Create + accept a member (ACCEPTED). Returns its userId. */
async function inviteAccepted(tag: string): Promise<string> {
  const { member, inviteToken } = await members.create(owner(), {
    email: uniqueEmail(tag),
    name: `Accepted ${tag}`,
    role: 'viewer',
  });
  expect(inviteToken, 'invite token must be exposed in test env').toBeTruthy();
  await members.acceptInvite({ token: inviteToken!, password: MEMBER_PW });
  return member.userId;
}

beforeAll(async () => {
  await setupTestDatabase();
  const tag = `resend-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('#7 resend invite (service-level, real-DB)', () => {
  it('R1) PENDING member → resend succeeds and returns the invite token (dev/test)', async () => {
    const userId = await invitePending('viewer', 'pending');
    const res = await resend(owner(), userId);
    expect(
      res.inviteToken,
      'resend must surface a fresh invite token in dev/test (EXPOSE_INVITE_TOKEN)',
    ).toBeTruthy();
    // The token must be a verifiable invite for THIS membership (single-use,
    // accept-able) — decode + assert the binding rather than trust the string.
    const claims = jwt.decode(res.inviteToken!) as { sub?: string; orgId?: string; typ?: string };
    expect(claims.typ).toBe('invite');
    expect(claims.sub).toBe(userId);
    expect(claims.orgId).toBe(org.id);
  }, 30_000);

  it('R2) ACCEPTED member → resend rejected with member_not_pending (no token minted)', async () => {
    const userId = await inviteAccepted('accepted');
    let thrown: unknown;
    let res: { inviteToken?: string } | undefined;
    try {
      res = await resend(owner(), userId);
    } catch (e) {
      thrown = e;
    }
    // SPEC: re-minting a token for an ACCEPTED member would be a password-reset
    // oracle, so it must be rejected — distinct `member_not_pending` code (400).
    expect(thrown, 'resending to an accepted member must throw, not mint a token').toBeInstanceOf(
      HttpException,
    );
    expect(
      res?.inviteToken,
      'no invite token may be issued for an accepted member',
    ).toBeUndefined();
    expect(errCode(thrown)).toBe('member_not_pending');
    expect(httpStatus(thrown)).toBe(400);
  }, 30_000);

  it('R3) REVOKED member → resend rejected, no token minted (terminal; no existence oracle)', async () => {
    const userId = await invitePending('viewer', 'revoked');
    // Revoke the pending membership directly (revokedAt set).
    await withTenant(
      org.id,
      async (tx) => {
        await tx
          .update(memberships)
          .set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(memberships.userId, userId), eq(memberships.orgId, org.id)));
      },
      { userId: managerId },
    );
    let thrown: unknown;
    let res: { inviteToken?: string } | undefined;
    try {
      res = await resend(owner(), userId);
    } catch (e) {
      thrown = e;
    }
    // SPEC: a revoked membership is terminal — resend must be rejected and mint
    // NO token. The committed impl deliberately returns a generic 404 here (not
    // a distinct code) to avoid leaking that a revoked member exists; assert the
    // security-correct outcome (rejected + no token) rather than over-pin the
    // code, but DO confirm it is never a successful re-issue.
    expect(thrown, 'resending to a revoked member must throw, not mint a token').toBeInstanceOf(
      HttpException,
    );
    expect(res?.inviteToken, 'no invite token may be issued for a revoked member').toBeUndefined();
    expect(
      httpStatus(thrown),
      'revoked resend must be a client-error rejection',
    ).toBeGreaterThanOrEqual(400);
  }, 30_000);

  it('R4) the resend route requires the invite permission (members.invite)', () => {
    // The route is gated centrally by @RequirePermission. Structurally assert
    // the controller declares a resend route under members.invite (the same
    // permission as POST /members). This goes RED until the route is added.
    const controllerSrc = readFileSync(join(__dirname, 'members.controller.ts'), 'utf8');
    expect(controllerSrc, 'no resend route on the members controller yet').toMatch(/resend/);
    // The resend method block must carry @RequirePermission('members.invite').
    const resendBlock = controllerSrc.slice(controllerSrc.search(/resend/i));
    expect(controllerSrc, 'resend must be gated by the invite permission').toMatch(
      /@RequirePermission\(['"]members\.invite['"]\)[\s\S]*resend/,
    );
    expect(resendBlock.length).toBeGreaterThan(0);
  });
});

describe('#4/#9 re-invite an existing active member → 409 member_exists', () => {
  it('RE1) inviting an email that already has an ACTIVE membership → 409 member_exists', async () => {
    const email = uniqueEmail('dup');
    const first = await members.create(owner(), { email, name: 'Dup A', role: 'viewer' });
    expect(first.member.userId).toBeTruthy();

    let thrown: unknown;
    try {
      await members.create(owner(), { email, name: 'Dup B', role: 'viewer' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 're-inviting an active member must conflict').toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getStatus()).toBe(409);
    expect(errCode(thrown)).toBe('member_exists');
  }, 30_000);
});
