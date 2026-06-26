/**
 * `SignatureStalledRecommender` — DB-backed detection tests (Autonomous Managing
 * System, wave 1.3). Proves the PERCEPTION-driven, PROJECT-level stalled
 * recommender:
 *   - DETECTS a non-terminal project with pending signatures AND an oldest-pending
 *     age ≥ the stalled threshold → EXACTLY ONE `reminder.send` condition at the
 *     PROJECT scope, carrying the right counts/age + a human-readable reason.
 *   - does NOT fire when there are NO pending signatures (all signed).
 *   - does NOT fire when the oldest pending is YOUNGER than the threshold (the
 *     "window is satisfied" / not-yet-stalled case).
 *   - does NOT fire on TERMINAL (completed/cancelled) or ARCHIVED projects (the
 *     assembler excludes them — inherited for free).
 *   - IDEMPOTENCY: re-detection yields the SAME deterministic dedup key (no
 *     timestamp/nonce) → the partial-unique makes a re-run a no-op ("no reminder
 *     this window").
 *   - the evidence is PII-FREE (project + counts + age only; no owner PII).
 *
 * Seeding is BYPASSRLS (`providerDb`); detection runs the recommender (which fans
 * the canonical assembler across orgs under withTenant). Run (needs DB + Infisical):
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/db exec vitest run \
 *     src/helpers/recommenders/signature-stalled.recommender.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { sql, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerDb } from '../../client';
import { apartments, buildings, organizations, owners, projects, users } from '../../schema/index';

import {
  SIGNATURE_STALLED_AGE_DAYS,
  SIGNATURE_STALLED_KIND,
  createSignatureStalledRecommender,
} from './signature-stalled.recommender';

const NOW = new Date('2026-06-26T12:00:00.000Z');
const DAY = 86_400_000;

let orgId: string;
let creator: string;

async function seedOrg(): Promise<void> {
  orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `stalled-${orgId.slice(0, 8)}`,
    slug: `stalled${orgId.slice(0, 8)}`.toLowerCase(),
  });
  const [user] = await providerDb
    .insert(users)
    .values({
      email: `stalled-${orgId}@test.local`,
      name: 'Stalled Test Manager',
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
    .values({ projectId, address: `s ${randomUUID().slice(0, 6)}`, city: 'TLV' })
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

/** A non-archived project-scoped document the signature request hangs off. */
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
  status: 'pending' | 'signed';
  createdAt: Date;
  expiresAt: Date;
  signedAt?: Date;
}): Promise<void> {
  await providerDb.execute(sql`
    INSERT INTO signature_requests
      (org_id, document_id, owner_id, jti, status, expires_at, created_at, created_by, signed_at)
    VALUES
      (${orgId}, ${opts.documentId}, ${opts.ownerId}, ${randomUUID()}, ${opts.status},
       ${opts.expiresAt.toISOString()}, ${opts.createdAt.toISOString()}, ${creator},
       ${opts.signedAt ? opts.signedAt.toISOString() : null})
  `);
}

// Fixture project ids.
let stalledProjectId: string; // pending + oldest age ≥ threshold → fires
let signedProjectId: string; // no pending → never fires
let freshProjectId: string; // pending but YOUNG → not stalled, never fires
let completedProjectId: string; // terminal → excluded
let archivedProjectId: string; // archived → excluded

beforeAll(async () => {
  await seedOrg();

  // ── STALLED: 1 pending request created well past the threshold. ──
  stalledProjectId = await seedProject({ status: 'gathering_signatures' });
  {
    const doc = await seedProjectDoc(stalledProjectId, 'agreement');
    const apt = await seedApartment(stalledProjectId);
    const owner = await seedOwner();
    await seedSoleOwnership(apt, owner);
    await seedSignatureRequest({
      documentId: doc,
      ownerId: owner,
      status: 'pending',
      createdAt: new Date(NOW.getTime() - (SIGNATURE_STALLED_AGE_DAYS + 5) * DAY),
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });
  }

  // ── SIGNED: the only request is signed → pending = 0 → never fires. ──
  signedProjectId = await seedProject({ status: 'gathering_signatures' });
  {
    const doc = await seedProjectDoc(signedProjectId, 'agreement');
    const apt = await seedApartment(signedProjectId);
    const owner = await seedOwner();
    await seedSoleOwnership(apt, owner);
    await seedSignatureRequest({
      documentId: doc,
      ownerId: owner,
      status: 'signed',
      createdAt: new Date(NOW.getTime() - 40 * DAY),
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
      signedAt: new Date(NOW.getTime() - 35 * DAY),
    });
  }

  // ── FRESH: a pending request younger than the threshold → not stalled. ──
  freshProjectId = await seedProject({ status: 'gathering_signatures' });
  {
    const doc = await seedProjectDoc(freshProjectId, 'agreement');
    const apt = await seedApartment(freshProjectId);
    const owner = await seedOwner();
    await seedSoleOwnership(apt, owner);
    await seedSignatureRequest({
      documentId: doc,
      ownerId: owner,
      status: 'pending',
      createdAt: new Date(NOW.getTime() - 2 * DAY), // 2 days old < threshold
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });
  }

  // ── TERMINAL + ARCHIVED projects with an old pending request — must be EXCLUDED. ──
  completedProjectId = await seedProject({ status: 'completed' });
  {
    const doc = await seedProjectDoc(completedProjectId, 'agreement');
    const apt = await seedApartment(completedProjectId);
    const owner = await seedOwner();
    await seedSoleOwnership(apt, owner);
    await seedSignatureRequest({
      documentId: doc,
      ownerId: owner,
      status: 'pending',
      createdAt: new Date(NOW.getTime() - 60 * DAY),
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });
  }
  archivedProjectId = await seedProject({ status: 'gathering_signatures', archived: true });
  {
    const doc = await seedProjectDoc(archivedProjectId, 'agreement');
    const apt = await seedApartment(archivedProjectId);
    const owner = await seedOwner();
    await seedSoleOwnership(apt, owner);
    await seedSignatureRequest({
      documentId: doc,
      ownerId: owner,
      status: 'pending',
      createdAt: new Date(NOW.getTime() - 60 * DAY),
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });
  }
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
  const all = await createSignatureStalledRecommender().detect({ now: NOW });
  return all.filter((c) => c.orgId === orgId);
}

describe('SignatureStalledRecommender.detect', () => {
  it('emits EXACTLY ONE reminder.send (project scope) for the stalled project, with correct evidence', async () => {
    const conditions = await detectFor();
    const stalled = conditions.filter((c) => c.scopeId === stalledProjectId);
    expect(stalled).toHaveLength(1);
    const c = stalled[0]!;
    expect(c.kind).toBe(SIGNATURE_STALLED_KIND);
    expect(c.scopeType).toBe('project');
    const ev = c.evidence as Record<string, unknown>;
    expect(ev['condition']).toBe('signature_stalled');
    expect(ev['projectId']).toBe(stalledProjectId);
    expect(ev['pendingSignatures']).toBe(1);
    expect(Number(ev['oldestPendingAgeDays'])).toBeGreaterThanOrEqual(SIGNATURE_STALLED_AGE_DAYS);
    expect(ev['stalledThresholdDays']).toBe(SIGNATURE_STALLED_AGE_DAYS);
    expect(typeof ev['reason']).toBe('string');
  });

  it('does NOT fire when there are no pending signatures (all signed)', async () => {
    const conditions = await detectFor();
    expect(conditions.filter((c) => c.scopeId === signedProjectId)).toHaveLength(0);
  });

  it('does NOT fire when the oldest pending is younger than the threshold (window satisfied)', async () => {
    const conditions = await detectFor();
    expect(conditions.filter((c) => c.scopeId === freshProjectId)).toHaveLength(0);
  });

  it('does NOT fire on terminal (completed) or archived projects', async () => {
    const conditions = await detectFor();
    expect(conditions.filter((c) => c.scopeId === completedProjectId)).toHaveLength(0);
    expect(conditions.filter((c) => c.scopeId === archivedProjectId)).toHaveLength(0);
  });

  it('the dedup key is deterministic per project; IDEMPOTENT across re-runs ("no reminder this window")', async () => {
    const keysA = (await detectFor()).map((c) => c.dedupKey).sort();
    const keysB = (await detectFor()).map((c) => c.dedupKey).sort();
    expect(keysA).toEqual(keysB);
    expect(keysA).toContain(`${SIGNATURE_STALLED_KIND}:project-stalled:${stalledProjectId}`);
    // Distinct scope/prefix from the per-request reminder-cadence key.
    expect(keysA.every((k) => k.startsWith(`${SIGNATURE_STALLED_KIND}:project-stalled:`))).toBe(
      true,
    );
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
