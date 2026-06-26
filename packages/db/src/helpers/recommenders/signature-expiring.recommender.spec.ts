/**
 * `SignatureExpiringRecommender` — DB-backed detection tests (Autonomous Managing
 * System, wave 1.3). Proves the PERCEPTION-driven anticipate-the-lapse recommender:
 *   - DETECTS a non-terminal project whose next pending request lapses within the
 *     window (and is still in the FUTURE) → EXACTLY ONE `signature_request.reissue`
 *     condition at the PROJECT scope, with the right next-expiry/days evidence.
 *   - does NOT fire when the next pending expiry is FURTHER than the window.
 *   - does NOT fire when there is NO pending request (nothing to lapse).
 *   - does NOT fire when the nearest pending request is ALREADY expired (that is the
 *     recover-path `signature-reissue` recommender's job, not anticipate).
 *   - does NOT fire on TERMINAL (completed/cancelled) or ARCHIVED projects.
 *   - IDEMPOTENCY: re-detection yields the SAME deterministic dedup key (no
 *     timestamp/nonce) → the partial-unique makes a re-run a no-op.
 *   - the evidence is PII-FREE (project + next-expiry + days only; no owner PII).
 *
 * Seeding is BYPASSRLS (`providerDb`). Run (needs DB + Infisical):
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/db exec vitest run \
 *     src/helpers/recommenders/signature-expiring.recommender.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { sql, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerDb } from '../../client';
import { apartments, buildings, organizations, owners, projects, users } from '../../schema/index';

import {
  SIGNATURE_EXPIRING_KIND,
  SIGNATURE_EXPIRING_WINDOW_DAYS,
  createSignatureExpiringRecommender,
} from './signature-expiring.recommender';

const NOW = new Date('2026-06-26T12:00:00.000Z');
const DAY = 86_400_000;

let orgId: string;
let creator: string;

async function seedOrg(): Promise<void> {
  orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `expiring-${orgId.slice(0, 8)}`,
    slug: `expiring${orgId.slice(0, 8)}`.toLowerCase(),
  });
  const [user] = await providerDb
    .insert(users)
    .values({
      email: `expiring-${orgId}@test.local`,
      name: 'Expiring Test Manager',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  creator = user!.id;
}

async function seedProject(opts: {
  status: 'gathering_signatures' | 'completed' | 'cancelled';
  archived?: boolean;
}): Promise<string> {
  const [row] = await providerDb
    .insert(projects)
    .values({
      orgId,
      name: `proj-${randomUUID().slice(0, 8)}`,
      type: 'tama38_1',
      status: opts.status,
      createdBy: creator,
      archivedAt: opts.archived ? NOW : null,
    })
    .returning({ id: projects.id });
  return row!.id;
}

async function seedApartment(projectId: string): Promise<string> {
  const [bld] = await providerDb
    .insert(buildings)
    .values({ projectId, address: `e ${randomUUID().slice(0, 6)}`, city: 'TLV' })
    .returning({ id: buildings.id });
  const [apt] = await providerDb
    .insert(apartments)
    .values({ buildingId: bld!.id, number: `A-${randomUUID().slice(0, 4)}` })
    .returning({ id: apartments.id });
  return apt!.id;
}

async function seedOwner(): Promise<string> {
  const [owner] = await providerDb.insert(owners).values({ orgId }).returning({ id: owners.id });
  return owner!.id;
}

async function seedSoleOwnership(apartmentId: string, ownerId: string): Promise<void> {
  await providerDb.execute(sql`
    INSERT INTO ownerships
      (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
    VALUES (${apartmentId}, ${ownerId}, 100, 'owner', 1, 1)
  `);
}

async function seedProjectDoc(projectId: string, type: string): Promise<string> {
  const res = await providerDb.execute<{ id: string }>(sql`
    INSERT INTO documents
      (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash,
       uploaded_by, uploaded_at, scan_status, doc_scope, doc_scope_id, archived_at)
    VALUES
      (${orgId}, ${projectId}, ${`${type}.pdf`}, ${type}, 'application/pdf', 100,
       ${`org/${orgId}/doc/${randomUUID()}`}, ${randomUUID()}, ${creator}, ${NOW.toISOString()},
       'clean', 'project', ${projectId}, null)
    RETURNING id
  `);
  return res.rows[0]!.id;
}

async function seedSignatureRequest(opts: {
  documentId: string;
  ownerId: string;
  status: 'pending' | 'expired';
  createdAt: Date;
  expiresAt: Date;
}): Promise<void> {
  await providerDb.execute(sql`
    INSERT INTO signature_requests
      (org_id, document_id, owner_id, jti, status, expires_at, created_at, created_by)
    VALUES
      (${orgId}, ${opts.documentId}, ${opts.ownerId}, ${randomUUID()}, ${opts.status},
       ${opts.expiresAt.toISOString()}, ${opts.createdAt.toISOString()}, ${creator})
  `);
}

/** Seed a project with ONE pending (or expired) request expiring at `expiresAt`. */
async function seedProjectWithRequest(opts: {
  status: 'gathering_signatures' | 'completed' | 'cancelled';
  archived?: boolean;
  reqStatus: 'pending' | 'expired';
  expiresAt: Date;
}): Promise<string> {
  const projectId = await seedProject({ status: opts.status, archived: opts.archived });
  const doc = await seedProjectDoc(projectId, 'agreement');
  const apt = await seedApartment(projectId);
  const owner = await seedOwner();
  await seedSoleOwnership(apt, owner);
  await seedSignatureRequest({
    documentId: doc,
    ownerId: owner,
    status: opts.reqStatus,
    createdAt: new Date(NOW.getTime() - 10 * DAY),
    expiresAt: opts.expiresAt,
  });
  return projectId;
}

// Fixture project ids.
let expiringSoonProjectId: string; // pending expiring in 3d (< window) → fires
let expiringFarProjectId: string; // pending expiring in 30d (> window) → no fire
let noPendingProjectId: string; // no pending request at all → no fire
let alreadyExpiredProjectId: string; // nearest pending already past → no fire
let completedProjectId: string; // terminal → excluded
let archivedProjectId: string; // archived → excluded

beforeAll(async () => {
  await seedOrg();

  expiringSoonProjectId = await seedProjectWithRequest({
    status: 'gathering_signatures',
    reqStatus: 'pending',
    expiresAt: new Date(NOW.getTime() + 3 * DAY), // within the 7d window
  });
  expiringFarProjectId = await seedProjectWithRequest({
    status: 'gathering_signatures',
    reqStatus: 'pending',
    expiresAt: new Date(NOW.getTime() + 30 * DAY), // beyond the window
  });
  // No pending: project exists but its only request is already SIGNED-equivalent —
  // here we just seed no request → nextExpiryAt null.
  noPendingProjectId = await seedProject({ status: 'gathering_signatures' });
  await seedProjectDoc(noPendingProjectId, 'agreement');
  // Already expired (in the PAST): the recover-path recommender owns this, not us.
  alreadyExpiredProjectId = await seedProjectWithRequest({
    status: 'gathering_signatures',
    reqStatus: 'pending',
    expiresAt: new Date(NOW.getTime() - 1 * DAY), // already lapsed
  });
  // Terminal + archived with a soon-expiring pending request — must be EXCLUDED.
  completedProjectId = await seedProjectWithRequest({
    status: 'completed',
    reqStatus: 'pending',
    expiresAt: new Date(NOW.getTime() + 3 * DAY),
  });
  archivedProjectId = await seedProjectWithRequest({
    status: 'gathering_signatures',
    archived: true,
    reqStatus: 'pending',
    expiresAt: new Date(NOW.getTime() + 3 * DAY),
  });
}, 120_000);

afterAll(async () => {
  await providerDb
    .execute(sql`DELETE FROM signature_requests WHERE org_id = ${orgId}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM documents WHERE org_id = ${orgId}`)
    .catch(() => undefined);
  await providerDb
    .execute(
      sql`DELETE FROM ownerships WHERE apartment_id IN (SELECT a.id FROM apartments a JOIN buildings b ON b.id = a.building_id JOIN projects p ON p.id = b.project_id WHERE p.org_id = ${orgId})`,
    )
    .catch(() => undefined);
  await providerDb
    .delete(owners)
    .where(eq(owners.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(projects)
    .where(eq(projects.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => undefined);
});

/** Detect, then keep only this org's conditions (the detection spans all orgs). */
async function detectFor() {
  const all = await createSignatureExpiringRecommender().detect({ now: NOW });
  return all.filter((c) => c.orgId === orgId);
}

describe('SignatureExpiringRecommender.detect', () => {
  it('emits EXACTLY ONE signature_request.reissue (project scope) for the soon-expiring project, with correct evidence', async () => {
    const conditions = await detectFor();
    const soon = conditions.filter((c) => c.scopeId === expiringSoonProjectId);
    expect(soon).toHaveLength(1);
    const c = soon[0]!;
    expect(c.kind).toBe(SIGNATURE_EXPIRING_KIND);
    expect(c.scopeType).toBe('project');
    const ev = c.evidence as Record<string, unknown>;
    expect(ev['condition']).toBe('signature_expiring');
    expect(ev['projectId']).toBe(expiringSoonProjectId);
    expect(typeof ev['nextExpiryAt']).toBe('string');
    expect(Number(ev['daysUntilExpiry'])).toBeGreaterThan(0);
    expect(Number(ev['daysUntilExpiry'])).toBeLessThanOrEqual(SIGNATURE_EXPIRING_WINDOW_DAYS);
    expect(ev['windowDays']).toBe(SIGNATURE_EXPIRING_WINDOW_DAYS);
  });

  it('does NOT fire when the next expiry is beyond the window', async () => {
    const conditions = await detectFor();
    expect(conditions.filter((c) => c.scopeId === expiringFarProjectId)).toHaveLength(0);
  });

  it('does NOT fire when there is no pending request', async () => {
    const conditions = await detectFor();
    expect(conditions.filter((c) => c.scopeId === noPendingProjectId)).toHaveLength(0);
  });

  it('does NOT fire when the nearest pending request is already expired (recover-path owns it)', async () => {
    const conditions = await detectFor();
    expect(conditions.filter((c) => c.scopeId === alreadyExpiredProjectId)).toHaveLength(0);
  });

  it('does NOT fire on terminal (completed) or archived projects', async () => {
    const conditions = await detectFor();
    expect(conditions.filter((c) => c.scopeId === completedProjectId)).toHaveLength(0);
    expect(conditions.filter((c) => c.scopeId === archivedProjectId)).toHaveLength(0);
  });

  it('the dedup key is deterministic per (project, expiry day); IDEMPOTENT across re-runs', async () => {
    const keysA = (await detectFor()).map((c) => c.dedupKey).sort();
    const keysB = (await detectFor()).map((c) => c.dedupKey).sort();
    expect(keysA).toEqual(keysB);
    expect(
      keysA.some((k) =>
        k.startsWith(`${SIGNATURE_EXPIRING_KIND}:project-expiring:${expiringSoonProjectId}:`),
      ),
    ).toBe(true);
  });

  it('the evidence is PII-FREE: no owner PII anywhere', async () => {
    const conditions = await detectFor();
    expect(conditions.length).toBeGreaterThan(0);
    for (const c of conditions) {
      const serialized = JSON.stringify(c.evidence);
      expect(serialized).not.toMatch(/national|phone|@|email|nationalId|ownerId|owner_id/i);
    }
  });
});
