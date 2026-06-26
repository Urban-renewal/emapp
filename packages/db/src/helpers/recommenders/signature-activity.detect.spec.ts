/**
 * `detectProjectSignatureActivity` — DB-backed detection tests (Autonomous Managing
 * System, wave 1.3). This is the SHARED, set-based projection both signature
 * recommenders (stalled / expiring) read FROM, so it must attribute a project's
 * pending-signature facts THROUGH the canonical doc-scope seam — NOT a hand-rolled
 * doc→project resolution that can drift from it.
 *
 * ── The single-source-of-truth assertion (the red-team HIGH this closes) ─────
 * A document can be linked to BOTH a project P (`documents.project_id`) AND an
 * apartment whose building is in a DIFFERENT project Q (the apartment→building
 * chain). The canonical seam (`projectSignatureDocIdsSql`, the UNION of the two
 * doc-paths) attributes that doc — and any pending signature on it — to BOTH P and
 * Q. A prior `COALESCE(d.project_id, b.project_id)` re-implementation here dropped
 * it from Q (it picked P only). This spec seeds exactly that dual-linked doc and
 * asserts the detector's per-project pending attribution EQUALS the canonical
 * assembler's (`assembleProjectPerception`) for BOTH P and Q — i.e. the divergence
 * is closed and both derive from the ONE seam.
 *
 * Seeding is BYPASSRLS (`providerDb`); the detector sweeps ALL orgs; the assembler
 * cross-check runs under `withTenant` (RLS-scoped). Run (needs DB + Infisical):
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/db exec vitest run \
 *     src/helpers/recommenders/signature-activity.detect.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { sql, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerDb } from '../../client';
import { apartments, buildings, organizations, owners, projects, users } from '../../schema/index';
import { withTenant } from '../../wrappers/with-tenant';
import { assembleProjectPerception } from '../perception/project-lifecycle.detect';

import { detectProjectSignatureActivity } from './signature-activity.detect';

const NOW = new Date('2026-06-26T12:00:00.000Z');
const DAY = 86_400_000;

let orgId: string;
let creator: string;

async function seedOrg(): Promise<void> {
  orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `sigact-${orgId.slice(0, 8)}`,
    slug: `sigact${orgId.slice(0, 8)}`.toLowerCase(),
  });
  const [user] = await providerDb
    .insert(users)
    .values({
      email: `sigact-${orgId}@test.local`,
      name: 'SigActivity Test Manager',
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

/** An apartment under a building in the given project. Returns the apartment id. */
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

/**
 * A non-archived document. `projectId` sets `documents.project_id`; `apartmentId`
 * sets `documents.apartment_id` (the apartment→building→project chain). Passing
 * BOTH (with apartment in a DIFFERENT project) creates the dual-linked case.
 */
async function seedDoc(opts: {
  type: string;
  projectId: string | null;
  apartmentId: string | null;
}): Promise<string> {
  const res = await providerDb.execute<{ id: string }>(sql`
    INSERT INTO documents
      (org_id, project_id, apartment_id, name, type, mime_type, size_bytes, r2_key,
       content_hash, uploaded_by, uploaded_at, scan_status, archived_at)
    VALUES
      (${orgId}, ${opts.projectId}, ${opts.apartmentId}, ${`${opts.type}.pdf`}, ${opts.type},
       'application/pdf', 100, ${`org/${orgId}/doc/${randomUUID()}`}, ${randomUUID()}, ${creator},
       ${NOW.toISOString()}, 'clean', null)
    RETURNING id
  `);
  return res.rows[0]!.id;
}

async function seedPendingRequest(
  documentId: string,
  ownerId: string,
  ageDays: number,
): Promise<void> {
  await providerDb.execute(sql`
    INSERT INTO signature_requests
      (org_id, document_id, owner_id, jti, status, expires_at, created_at, created_by)
    VALUES
      (${orgId}, ${documentId}, ${ownerId}, ${randomUUID()}, 'pending',
       ${new Date(NOW.getTime() + 30 * DAY).toISOString()},
       ${new Date(NOW.getTime() - ageDays * DAY).toISOString()}, ${creator})
  `);
}

// Fixtures.
let projectP: string; // holds the dual-linked doc via documents.project_id
let projectQ: string; // holds it via an apartment whose building is in Q
let pProjectDocId: string; // P-only project-scoped doc (a baseline pending request)

beforeAll(async () => {
  await seedOrg();

  projectP = await seedProject({ status: 'gathering_signatures' });
  projectQ = await seedProject({ status: 'gathering_signatures' });

  // P gets one ordinary project-scoped pending request (baseline pending = 1 so far).
  {
    pProjectDocId = await seedDoc({ type: 'agreement', projectId: projectP, apartmentId: null });
    const apt = await seedApartment(projectP);
    const owner = await seedOwner();
    await seedSoleOwnership(apt, owner);
    await seedPendingRequest(pProjectDocId, owner, 20);
  }

  // ── THE DUAL-LINKED DOC ──────────────────────────────────────────────────
  // A document linked to BOTH project P (project_id) AND an apartment whose
  // building is in project Q. The canonical UNION attributes it to BOTH P and Q.
  {
    const aptInQ = await seedApartment(projectQ);
    const ownerInQ = await seedOwner();
    await seedSoleOwnership(aptInQ, ownerInQ);
    const dualDoc = await seedDoc({
      type: 'agreement',
      projectId: projectP, // project-level link → P
      apartmentId: aptInQ, // apartment→building link → Q
    });
    await seedPendingRequest(dualDoc, ownerInQ, 25);
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

async function detectForOrg() {
  const all = await detectProjectSignatureActivity(NOW);
  return all.filter((r) => r.orgId === orgId);
}

describe('detectProjectSignatureActivity — single source of truth with the canonical seam', () => {
  it('attributes a dual-linked document (project P AND an apartment in project Q) to BOTH P and Q', async () => {
    const rows = await detectForOrg();
    const p = rows.find((r) => r.projectId === projectP);
    const q = rows.find((r) => r.projectId === projectQ);

    // P sees its own project-scoped pending (1) PLUS the dual-linked doc's pending (1).
    expect(p).toBeDefined();
    expect(p!.pending).toBe(2);

    // Q sees the SAME dual-linked doc's pending — it is NOT dropped (the COALESCE bug).
    expect(q).toBeDefined();
    expect(q!.pending).toBe(1);
  });

  it("matches the canonical assembler's per-project pending for BOTH P and Q (divergence closed)", async () => {
    const detected = await detectForOrg();
    const perception = await withTenant(orgId, async (tx) => assembleProjectPerception(tx));

    for (const projectId of [projectP, projectQ]) {
      const d = detected.find((r) => r.projectId === projectId);
      const a = perception.find((r) => r.projectId === projectId);
      expect(d, `detector row for ${projectId}`).toBeDefined();
      expect(a, `assembler row for ${projectId}`).toBeDefined();
      // The two MUST agree — both derive pending from the ONE canonical doc-scope seam.
      expect(d!.pending).toBe(a!.signatures.pending);
    }
  });

  it('the rows are PII-FREE: ids, counts and timestamps only', async () => {
    const rows = await detectForOrg();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const serialized = JSON.stringify(r);
      expect(serialized).not.toMatch(/national|phone|@|email|nationalId|owner/i);
    }
  });
});
