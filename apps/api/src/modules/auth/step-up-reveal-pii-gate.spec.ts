/**
 * B5 (red-team blocker) — the PII step-up unlock must be gated on the SAME
 * cleartext-PII capability (`owners.reveal_pii`) as every other PII-reveal
 * surface, at BOTH layers (defence in depth):
 *
 *   1. CONTROLLER — the step-up unlock endpoints (request + verify) carry
 *      `@RequirePermission('owners.reveal_pii')`, enforced by the engine-backed
 *      AuthorizationGuard. A Viewer (documents.read+download but NOT
 *      owners.reveal_pii) or a default Agent (reveal_pii OFF) is 403 BEFORE any
 *      OTP is minted to their inbox.
 *
 *   2. DOCUMENTS — `DocumentsService.assertPiiUnlocked` re-asserts the live
 *      effective permission set contains `owners.reveal_pii` before honoring a
 *      session unlock. So even a PRE-EXISTING / forged `pii_unlocked_at` (e.g.
 *      planted, or stamped before a role lost the permission) can NEVER be
 *      leveraged by a role that does not currently hold reveal-PII.
 *
 * THE BUG (before the fix): the unlock endpoints were `@UseGuards(AuthGuard)`
 * ONLY — no permission gate — and the doc gate checked ONLY pii_unlocked_at +
 * TTL, never the caller's role. A Viewer could self-request an OTP to their own
 * inbox, verify it, and download national_id-dense sensitive documents.
 *
 * Real-DB harness: seeds members with org-scoped `role_assignments` rows so the
 * slice-5 engine resolves the genuine role permission set (mirrors
 * auth-agent-effective-permissions.spec.ts), drives the REAL AuthorizationGuard
 * against the REAL controller handlers (so the `@RequirePermission` metadata
 * under test is the one exercised), and drives the REAL DocumentsService gate.
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  NoopFileScanProvider,
  db,
  memberships,
  projectAssignments,
  users,
  type IStorageProvider,
} from '@emapp/db';
import { ExecutionContext, ForbiddenException, HttpException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { type SystemRoleKey } from '../../common/authz/system-roles';
import { DocumentsService } from '../documents/documents.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import type { AccessTokenPayload } from './auth.service';
import { StepUpController } from './step-up.controller';

const GET_URL = 'https://r2.example.test/presigned-get';

// ── stub storage (download path never touches a real R2) ────────────────────
class StubStorage implements IStorageProvider {
  async getUploadUrl(): Promise<string> {
    return 'https://r2.example.test/put';
  }
  async getDownloadUrl(): Promise<string> {
    return GET_URL;
  }
  async head(): Promise<null> {
    return null;
  }
  async delete(): Promise<void> {}
  async putObject(): Promise<void> {}
  async getObjectStream(): Promise<Readable> {
    return Readable.from([Buffer.from('%PDF-1.4')]);
  }
  async healthCheck(): Promise<void> {}
}

let org: TestOrg;
let managerId: string;
let projectId: string;

function payload(userId: string, sid: string, role: AccessTokenPayload['role']): AccessTokenPayload {
  return { sub: userId, orgId: org.id, role, sid, type: 'access' } as unknown as AccessTokenPayload;
}

function errCode(e: unknown): string | undefined {
  if (e instanceof HttpException) {
    const body = e.getResponse() as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function errStatus(e: unknown): number | undefined {
  return e instanceof HttpException ? e.getStatus() : undefined;
}

/** Resolve a seeded system role id by key (org_id IS NULL). */
async function systemRoleId(key: SystemRoleKey): Promise<string> {
  const r = await providerPool.query<{ id: string }>(
    `SELECT id FROM roles WHERE org_id IS NULL AND is_system = true AND key = $1`,
    [key],
  );
  if (!r.rows[0]) throw new Error(`system role not seeded: ${key}`);
  return r.rows[0].id;
}

/**
 * Seed a user + accepted membership + an org-scoped `role_assignments` row so
 * the engine resolves the role's genuine permission set. Returns the userId.
 */
async function seedMember(role: 'manager' | 'agent' | 'viewer'): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `b5-${role}-${randomUUID()}@test.local`,
      name: `${role} user`,
      passwordHash: '$2b$12$x',
    })
    .returning({ id: users.id });
  const userId = u!.id;
  await db.insert(memberships).values({ userId, orgId: org.id, role, acceptedAt: new Date() });
  const roleId = await systemRoleId(role);
  await providerPool.query(
    `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_at)
     VALUES ($1, $2, 'org', $3, now())
     ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
    [userId, roleId, org.id],
  );
  // An agent only SEES a project doc on an active assignment (loadVisible →
  // assertDocVisibleForAgent → 404 otherwise). Assign so the download reaches
  // the reveal-PII gate under test (else we'd assert 404, not the gate's 403).
  if (role === 'agent') {
    await db
      .insert(projectAssignments)
      .values({ projectId, userId, assignedBy: managerId });
  }
  return userId;
}

/** A live auth_sessions row. */
async function seedSession(userId: string): Promise<string> {
  const r = await providerPool.query<{ id: string }>(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '30 days') RETURNING id`,
    [userId, `b5-${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

/** Forge pii_unlocked_at = now() on a session (the pre-existing-unlock attack). */
async function forgeUnlock(sessionId: string): Promise<void> {
  await providerPool.query(`UPDATE auth_sessions SET pii_unlocked_at = now() WHERE id = $1`, [
    sessionId,
  ]);
}

/** Seed a FINALIZED sensitive document via raw SQL (BYPASSRLS pool). */
async function seedSensitiveDoc(uploaderId: string): Promise<string> {
  const r = await providerPool.query<{ id: string }>(
    `INSERT INTO documents (org_id, project_id, name, type, mime_type, size_bytes,
       r2_key, content_hash, uploaded_by, uploaded_at, scan_status, sensitive)
     VALUES ($1, $2, 'nesach.pdf', 'land_registry', 'application/pdf', 100,
       $3, $4, $5, now(), 'clean', true) RETURNING id`,
    [org.id, projectId, `org/${org.id}/doc/${randomUUID()}`, `h-${randomUUID()}`, uploaderId],
  );
  return r.rows[0]!.id;
}

function docsSvc(): DocumentsService {
  return new DocumentsService(
    new StubStorage(),
    new NoopFileScanProvider(),
    new NotificationsProducerService(),
  );
}

/**
 * Drive the REAL AuthorizationGuard against the REAL StepUpController handler,
 * exercising the `@RequirePermission('owners.reveal_pii')` metadata under test.
 * Returns true if allowed; rethrows the guard's ForbiddenException otherwise.
 */
async function guardStepUp(
  handlerName: 'request' | 'verify',
  user: AccessTokenPayload,
): Promise<boolean> {
  const guard = new AuthorizationGuard();
  const handler = StepUpController.prototype[handlerName];
  const ctx = {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
  return guard.canActivate(ctx);
}

beforeAll(async () => {
  await setupTestDatabase();
  const tag = `b5-reveal-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id; // factory now seeds a manager role_assignment
  projectId = org.projects[0]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools closed by global teardown */
});

// ───────────────────────────────────────────────────────────────────────────
// Layer 1 — the controller permission gate (request + verify)
// ───────────────────────────────────────────────────────────────────────────
describe('B5 · step-up unlock endpoints require owners.reveal_pii', () => {
  it('a VIEWER hitting step-up/request → 403 (no OTP minted to their inbox)', async () => {
    const viewerId = await seedMember('viewer');
    const sid = await seedSession(viewerId);
    let thrown: unknown;
    try {
      await guardStepUp('request', payload(viewerId, sid, 'viewer'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'viewer reached step-up/request — PII escalation').toBeInstanceOf(
      ForbiddenException,
    );
    expect(errCode(thrown)).toBe('forbidden');
  }, 40_000);

  it('a VIEWER hitting step-up/verify → 403', async () => {
    const viewerId = await seedMember('viewer');
    const sid = await seedSession(viewerId);
    await expect(guardStepUp('verify', payload(viewerId, sid, 'viewer'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  }, 40_000);

  it('a DEFAULT AGENT (reveal_pii OFF) hitting step-up/request → 403', async () => {
    const agentId = await seedMember('agent');
    const sid = await seedSession(agentId);
    await expect(guardStepUp('request', payload(agentId, sid, 'agent'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  }, 40_000);

  it('a MANAGER hitting step-up/request + verify → ALLOWED (no regression)', async () => {
    const sid = await seedSession(managerId);
    expect(await guardStepUp('request', payload(managerId, sid, 'manager'))).toBe(true);
    expect(await guardStepUp('verify', payload(managerId, sid, 'manager'))).toBe(true);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// Layer 2 — the documents gate re-asserts reveal_pii (defence in depth)
// ───────────────────────────────────────────────────────────────────────────
describe('B5 · sensitive-doc gate re-asserts owners.reveal_pii on the live caller', () => {
  it('a VIEWER with a FORGED pii_unlocked_at → sensitive download 403 (pre-existing unlock cannot be leveraged)', async () => {
    const viewerId = await seedMember('viewer');
    const sid = await seedSession(viewerId);
    await forgeUnlock(sid); // plant a valid, fresh unlock the role must NOT be able to use
    const docId = await seedSensitiveDoc(managerId);

    let thrown: unknown;
    try {
      await docsSvc().getDownloadUrl(payload(viewerId, sid, 'viewer'), docId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a viewer with a forged unlock downloaded a sensitive PII doc').toBeTruthy();
    expect(errStatus(thrown)).toBe(403);
    expect(errCode(thrown)).toBe('pii_step_up_required');
  }, 40_000);

  it('a DEFAULT AGENT (no reveal_pii) with a forged unlock → sensitive download 403', async () => {
    const agentId = await seedMember('agent');
    const sid = await seedSession(agentId);
    await forgeUnlock(sid);
    const docId = await seedSensitiveDoc(managerId);

    await expect(
      docsSvc().getDownloadUrl(payload(agentId, sid, 'agent'), docId),
    ).rejects.toMatchObject({ response: { error: { code: 'pii_step_up_required' } } });
  }, 40_000);

  it('a MANAGER with a valid unlock → sensitive download 200 (no regression)', async () => {
    const sid = await seedSession(managerId);
    await forgeUnlock(sid); // manager DOES hold reveal_pii → unlock honored
    const docId = await seedSensitiveDoc(managerId);

    const dl = await docsSvc().getDownloadUrl(payload(managerId, sid, 'manager'), docId);
    expect(dl.url).toBe(GET_URL);
  }, 40_000);
});
