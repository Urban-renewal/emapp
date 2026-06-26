/**
 * Slice 2.5 — OwnerStatesService acceptance tests (service-level, real local DB).
 *
 * Pins the load-bearing contract:
 *   1. create() encrypts guardian PII at rest + returns a MASKED guardian label
 *      (never cleartext), and the audit afterState carries WHICH guardian fields
 *      were supplied (names only) — NEVER their values.
 *   2. list returns the active states (masked) for an owner.
 *   3. resolve() is a manager-gated status transition (idempotent), not a delete.
 *   4. a non-manager (agent/viewer) is FORBIDDEN from create/resolve.
 *   5. a cross-org / missing owner is a no-oracle 404.
 *
 * Harness mirrors owners-audit-pii.spec.ts: direct service instantiation + a fake
 * AccessTokenPayload, seeding via providerDb (BYPASSRLS).
 *
 * Run:
 *   infisical run --env dev -- bash -c 'export DB_TARGET=local; \
 *     export LOCAL_DATABASE_URL="postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable"; \
 *     pnpm --filter @emapp/api exec vitest run src/modules/owners/owner-states.service.spec.ts'
 */
import { randomUUID } from 'node:crypto';

import { auditLog, organizations, ownerStates, owners, providerDb, users } from '@emapp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AccessTokenPayload } from '../auth/auth.service';

import { OwnerStatesService } from './owner-states.service';

const TEST_PREFIX = 'slice25-os-svc';
const TEST_SID = '00000000-0000-4000-8000-00000000beef';

let orgId: string;
let userId: string;
let ownerId: string;
let svc: OwnerStatesService;

function user(role: 'manager' | 'agent' | 'viewer' = 'manager'): AccessTokenPayload {
  return {
    sub: userId,
    orgId,
    role,
    sid: TEST_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function seed(): Promise<void> {
  orgId = randomUUID();
  userId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `${TEST_PREFIX}-${orgId.slice(0, 8)}`,
    slug: `${TEST_PREFIX}-${orgId.slice(0, 8)}`.replace(/[^a-z0-9-]/gi, '').slice(0, 30),
  });
  await providerDb.insert(users).values({
    id: userId,
    email: `${TEST_PREFIX}-${userId.slice(0, 8)}@test.local`,
    passwordHash: 'argon2id$dummy',
    name: 'slice25 svc test',
  });
  const [o] = await providerDb
    .insert(owners)
    .values({ id: randomUUID(), orgId })
    .returning({ id: owners.id });
  ownerId = o!.id;
}

async function cleanup(): Promise<void> {
  await providerDb
    .delete(ownerStates)
    .where(eq(ownerStates.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(owners)
    .where(eq(owners.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(users)
    .where(eq(users.id, userId))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => undefined);
}

describe('Slice 2.5 — OwnerStatesService', () => {
  beforeAll(async () => {
    await seed();
    svc = new OwnerStatesService();
  });
  afterAll(cleanup);

  it('1) create() masks the guardian name + flags blocking; cleartext never returned', async () => {
    const view = await svc.create(user(), ownerId, {
      kind: 'competency',
      guardianName: 'דנה כהן',
      guardianPhone: '0501234567',
    });
    expect(view.kind).toBe('competency');
    expect(view.isBlocking).toBe(true);
    expect(view.status).toBe('active');
    // Masked — first grapheme + ellipsis, NEVER the full name.
    expect(view.guardianNameMasked).toBe('ד•••');
    expect(JSON.stringify(view)).not.toContain('כהן');
    expect(JSON.stringify(view)).not.toContain('0501234567');
    expect(view.hasGuardianContact).toBe(true);
  });

  it('2) the audit afterState carries guardian FIELD NAMES, never values', async () => {
    const rows = await providerDb
      .select({ afterState: auditLog.afterState, action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const createRow = rows.find((r) => r.action === 'owner_state.create');
    expect(createRow).toBeTruthy();
    const blob = JSON.stringify(createRow!.afterState);
    expect(blob).toContain('guardianFields');
    expect(blob).toContain('name');
    expect(blob).toContain('phone');
    // NEVER the cleartext values.
    expect(blob).not.toContain('דנה');
    expect(blob).not.toContain('כהן');
    expect(blob).not.toContain('0501234567');
  });

  it('3) the encrypted column at rest is NOT the plaintext', async () => {
    const [row] = await providerDb
      .select({ enc: ownerStates.guardianNameEncrypted })
      .from(ownerStates)
      .where(eq(ownerStates.ownerId, ownerId))
      .limit(1);
    expect(row?.enc).toBeTruthy();
    expect(Buffer.isBuffer(row!.enc)).toBe(true);
    expect((row!.enc as Buffer).toString('utf8')).not.toContain('דנה');
  });

  it('4) list returns the active state (masked) for the owner', async () => {
    const list = await svc.listForOwner(user('viewer'), ownerId);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]!.guardianNameMasked === null || list[0]!.guardianNameMasked!.includes('•')).toBe(
      true,
    );
  });

  it('5) a non-manager cannot create or resolve (FORBIDDEN)', async () => {
    await expect(svc.create(user('agent'), ownerId, { kind: 'verify' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(svc.resolve(user('viewer'), randomUUID())).rejects.toMatchObject({ status: 403 });
  });

  it('6) resolve() transitions active→resolved and is idempotent', async () => {
    const created = await svc.create(user(), ownerId, { kind: 'dispute', subKind: 'tik-123' });
    const r1 = await svc.resolve(user(), created.id);
    expect(r1.status).toBe('resolved');
    expect(r1.resolvedAt).not.toBeNull();
    // Idempotent — a second resolve is a no-op that still returns the resolved view.
    const r2 = await svc.resolve(user(), created.id);
    expect(r2.status).toBe('resolved');
  });

  it('7) a missing/cross-org owner is a no-oracle 404 on create', async () => {
    await expect(svc.create(user(), randomUUID(), { kind: 'verify' })).rejects.toMatchObject({
      status: 404,
    });
  });
});
