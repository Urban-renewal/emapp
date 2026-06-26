/**
 * Slice 2.7 — ApartmentStatesService acceptance tests (service-level, real local DB).
 *
 * The structural mirror of `owner-states.service.spec.ts` (2.5), adapted to
 * APARTMENTS and PII-FREE. Pins the load-bearing contract:
 *   1. create() records the state + flags blocking; the audit afterState carries the
 *      kind + a hasNote boolean (PII-FREE — no person/contact values).
 *   2. list returns the active states for an apartment.
 *   3. resolve() is a manager-gated status transition (idempotent), not a delete.
 *   4. a non-manager (agent/viewer) is FORBIDDEN from create/resolve.
 *   5. a cross-org / missing apartment is a no-oracle 404.
 *
 * Harness: direct service instantiation + a fake AccessTokenPayload, seeding via
 * providerDb (BYPASSRLS).
 *
 * Run (fresh throwaway DB):
 *   infisical run --env dev -- bash -c 'export DB_TARGET=local; \
 *     export LOCAL_DATABASE_URL="postgresql://postgres:1234@localhost:5432/emapp_v27?sslmode=disable"; \
 *     pnpm --filter @emapp/api exec vitest run src/modules/apartments/apartment-states.service.spec.ts'
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  apartmentStates,
  auditLog,
  buildings,
  organizations,
  projects,
  providerDb,
  users,
} from '@emapp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AccessTokenPayload } from '../auth/auth.service';

import { ApartmentStatesService } from './apartment-states.service';

const TEST_PREFIX = 'slice27-as-svc';
const TEST_SID = '00000000-0000-4000-8000-00000000beef';

let orgId: string;
let userId: string;
let projectId: string;
let buildingId: string;
let apartmentId: string;
let svc: ApartmentStatesService;

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
    name: 'slice27 svc test',
  });
  const [proj] = await providerDb
    .insert(projects)
    .values({
      id: randomUUID(),
      orgId,
      name: 'svc test project',
      type: 'tama38_1',
      status: 'gathering_signatures',
      createdBy: userId,
    })
    .returning({ id: projects.id });
  projectId = proj!.id;
  const [bld] = await providerDb
    .insert(buildings)
    .values({ id: randomUUID(), projectId, address: 'rehov 1', city: 'tel aviv' })
    .returning({ id: buildings.id });
  buildingId = bld!.id;
  const [apt] = await providerDb
    .insert(apartments)
    .values({ id: randomUUID(), buildingId, number: '1' })
    .returning({ id: apartments.id });
  apartmentId = apt!.id;
}

async function cleanup(): Promise<void> {
  await providerDb
    .delete(apartmentStates)
    .where(eq(apartmentStates.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(apartments)
    .where(eq(apartments.buildingId, buildingId))
    .catch(() => undefined);
  await providerDb
    .delete(buildings)
    .where(eq(buildings.projectId, projectId))
    .catch(() => undefined);
  await providerDb
    .delete(projects)
    .where(eq(projects.orgId, orgId))
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

describe('Slice 2.7 — ApartmentStatesService', () => {
  beforeAll(async () => {
    await seed();
    svc = new ApartmentStatesService();
  });
  afterAll(cleanup);

  it('1) create() records the state + flags blocking; subKind/note round-trip', async () => {
    const view = await svc.create(user(), apartmentId, {
      kind: 'eviction',
      subKind: 'tik-99',
      note: 'protected tenant',
    });
    expect(view.kind).toBe('eviction');
    expect(view.isBlocking).toBe(true);
    expect(view.status).toBe('active');
    expect(view.subKind).toBe('tik-99');
    expect(view.note).toBe('protected tenant');
  });

  it('2) the audit afterState carries the kind + hasNote, PII-FREE', async () => {
    const rows = await providerDb
      .select({ afterState: auditLog.afterState, action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const createRow = rows.find((r) => r.action === 'apartment_state.create');
    expect(createRow).toBeTruthy();
    const blob = JSON.stringify(createRow!.afterState);
    expect(blob).toContain('kind');
    expect(blob).toContain('hasNote');
    // No person/contact field shape.
    expect(blob).not.toContain('national');
    expect(blob).not.toContain('phone');
  });

  it('3) list returns the active state for the apartment', async () => {
    const list = await svc.listForApartment(user('viewer'), apartmentId);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]!.apartmentId).toBe(apartmentId);
  });

  it('4) a non-manager cannot create or resolve (FORBIDDEN)', async () => {
    await expect(svc.create(user('agent'), apartmentId, { kind: 'repairs' })).rejects.toMatchObject(
      { status: 403 },
    );
    await expect(svc.resolve(user('viewer'), randomUUID())).rejects.toMatchObject({ status: 403 });
  });

  it('5) resolve() transitions active→resolved and is idempotent', async () => {
    const created = await svc.create(user(), apartmentId, { kind: 'dispute', subKind: 'd-1' });
    const r1 = await svc.resolve(user(), created.id);
    expect(r1.status).toBe('resolved');
    expect(r1.resolvedAt).not.toBeNull();
    // Idempotent — a second resolve is a no-op that still returns the resolved view.
    const r2 = await svc.resolve(user(), created.id);
    expect(r2.status).toBe('resolved');
  });

  it('6) a missing/cross-org apartment is a no-oracle 404 on create', async () => {
    await expect(svc.create(user(), randomUUID(), { kind: 'repairs' })).rejects.toMatchObject({
      status: 404,
    });
  });
});
