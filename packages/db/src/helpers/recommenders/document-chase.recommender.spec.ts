/**
 * `DocumentChaseRecommender` — DB-backed detection tests (DOCUMENTS-PROCESS-DESIGN
 * S5). Proves the OUTBOUND document-chase recommender:
 *   - SET-BASED detection across orgs (one query, the SHARED canonical
 *     `detectMissingRequiredDocs`) finds a `gathering_signatures` project missing a
 *     required doc type and emits EXACTLY ONE `document.chase.send` condition per
 *     (project, missing type).
 *   - track-correct required sets: a pinui_binui project additionally needs a
 *     `regulation`; a tama38 project does NOT.
 *   - a COMPLETE project (all required types present, non-archived) yields NOTHING;
 *     an archived doc does NOT count as present.
 *   - non-gathering_signatures + archived projects are ignored.
 *   - IDEMPOTENCY: re-detection yields the SAME deterministic dedup keys (no
 *     timestamp/nonce) so the partial-unique makes a re-run a no-op.
 *   - the dedup key is per (project, doc type) with the chase KIND prefix (distinct
 *     from the TaskWatcher key → both proposals can coexist for one gap).
 *   - the evidence is PII-FREE (project + type + track only; no owner/party PII; the
 *     party is DERIVED downstream from missingDocType, not stored).
 *
 * Detection is SHARED with the TaskWatcher (one source of truth), so this spec is the
 * chase-specific counterpart to `task-watcher.recommender.spec.ts` — it asserts the
 * KIND + dedup-key + evidence the chase produces, not the shared detection mechanics
 * (those are covered there + in `missing-required-doc.detect` via both consumers).
 *
 * Seeding is BYPASSRLS (`providerDb`). Run (needs DB + Infisical):
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/db exec vitest run \
 *     src/helpers/recommenders/document-chase.recommender.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerDb } from '../../client';
import { documents, organizations, projects, users } from '../../schema/index';

import {
  DOCUMENT_CHASE_KIND,
  createDocumentChaseRecommender,
} from './document-chase.recommender';

const NOW = new Date('2026-06-22T12:00:00.000Z');

let uploader: string;

async function seedOrg(tag: string): Promise<string> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `dc-${tag}-${orgId.slice(0, 8)}`,
    slug: `dc${tag}${orgId.slice(0, 8)}`.toLowerCase(),
  });
  return orgId;
}

async function seedProject(opts: {
  orgId: string;
  type: 'tama38_1' | 'tama38_2' | 'pinui_binui' | 'other';
  status: 'planning' | 'gathering_signatures' | 'approved';
  archived?: boolean;
}): Promise<string> {
  const [row] = await providerDb
    .insert(projects)
    .values({
      orgId: opts.orgId,
      name: `proj-${randomUUID().slice(0, 8)}`,
      type: opts.type,
      status: opts.status,
      createdBy: uploader,
      archivedAt: opts.archived ? NOW : null,
    })
    .returning({ id: projects.id });
  return row!.id;
}

/** Seed a present, finalized, non-archived project-scoped document of `type`. */
async function seedDoc(opts: {
  orgId: string;
  projectId: string;
  type: string;
  archived?: boolean;
}): Promise<void> {
  await providerDb.insert(documents).values({
    orgId: opts.orgId,
    projectId: opts.projectId,
    name: `${opts.type}.pdf`,
    type: opts.type,
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    r2Key: `test/${randomUUID()}`,
    contentHash: randomUUID(),
    uploadedBy: uploader,
    uploadedAt: NOW,
    scanStatus: 'clean',
    docScope: 'project',
    docScopeId: opts.projectId,
    archivedAt: opts.archived ? NOW : null,
  });
}

/** Detect, then return only the conditions for `orgId` (the pool spans all orgs). */
async function detectFor(orgId: string) {
  const all = await createDocumentChaseRecommender().detect({ now: NOW });
  return all.filter((c) => c.orgId === orgId);
}

beforeAll(async () => {
  const [u] = await providerDb
    .insert(users)
    .values({
      email: `dc-${randomUUID().slice(0, 8)}@test.local`,
      name: 'DC Uploader',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  uploader = u!.id;
}, 120_000);

afterAll(async () => {
  await Promise.resolve();
});

describe('DocumentChaseRecommender.detect', () => {
  it('emits EXACTLY ONE document.chase.send per MISSING required type (tama38)', async () => {
    const orgId = await seedOrg('miss');
    const projectId = await seedProject({
      orgId,
      type: 'tama38_1',
      status: 'gathering_signatures',
    });
    // Present: agreement only. Missing: land_registry + blueprint.
    await seedDoc({ orgId, projectId, type: 'agreement' });

    const conditions = await detectFor(orgId);
    const missing = conditions.map(
      (c) => (c.evidence as { missingDocType: string }).missingDocType,
    );
    // EXACTLY the two missing required types — one condition each, no duplicates.
    expect(new Set(missing)).toEqual(new Set(['land_registry', 'blueprint']));
    expect(missing).toHaveLength(2);

    for (const c of conditions) {
      expect(c.kind).toBe(DOCUMENT_CHASE_KIND);
      expect(c.scopeType).toBe('project');
      expect(c.scopeId).toBe(projectId);
      const ev = c.evidence as Record<string, unknown>;
      expect(ev).toMatchObject({ condition: 'missing_required_doc', projectId, track: 'tama38' });
    }
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('the dedup key is deterministic per (project, missing type) with the chase prefix; IDEMPOTENT across re-runs', async () => {
    const orgId = await seedOrg('dedup');
    const projectId = await seedProject({
      orgId,
      type: 'tama38_1',
      status: 'gathering_signatures',
    });
    // Missing everything (no docs seeded) → 3 conditions.
    const a = await detectFor(orgId);
    const b = await detectFor(orgId);
    const keysA = a.map((c) => c.dedupKey).sort();
    const keysB = b.map((c) => c.dedupKey).sort();
    // Re-detection yields the SAME keys (no nonce) → the partial-unique no-ops it.
    expect(keysA).toEqual(keysB);
    expect(keysA).toContain(`${DOCUMENT_CHASE_KIND}:${projectId}:land_registry`);
    expect(keysA).toContain(`${DOCUMENT_CHASE_KIND}:${projectId}:agreement`);
    expect(keysA).toContain(`${DOCUMENT_CHASE_KIND}:${projectId}:blueprint`);
    // DISTINCT from the TaskWatcher key (different kind prefix) so both can coexist.
    expect(keysA.some((k) => k.startsWith('task.create'))).toBe(false);
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('pinui_binui ALSO chases a regulation; tama38 does NOT', async () => {
    const orgId = await seedOrg('track');
    const pb = await seedProject({ orgId, type: 'pinui_binui', status: 'gathering_signatures' });
    const tama = await seedProject({ orgId, type: 'tama38_2', status: 'gathering_signatures' });

    const conditions = await detectFor(orgId);
    const pbMissing = conditions
      .filter((c) => c.scopeId === pb)
      .map((c) => (c.evidence as { missingDocType: string }).missingDocType);
    const tamaMissing = conditions
      .filter((c) => c.scopeId === tama)
      .map((c) => (c.evidence as { missingDocType: string }).missingDocType);

    expect(pbMissing).toContain('regulation');
    expect(tamaMissing).not.toContain('regulation');
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('a COMPLETE project yields nothing; an archived doc does NOT count as present', async () => {
    const orgId = await seedOrg('complete');
    const complete = await seedProject({
      orgId,
      type: 'tama38_1',
      status: 'gathering_signatures',
    });
    for (const t of ['agreement', 'land_registry', 'blueprint']) {
      await seedDoc({ orgId, projectId: complete, type: t });
    }
    let conditions = await detectFor(orgId);
    expect(conditions.filter((c) => c.scopeId === complete)).toHaveLength(0);

    // Archive the blueprint → it must re-surface as a chase (archived ≠ present).
    await providerDb.execute(
      sql`UPDATE documents SET archived_at = ${NOW} WHERE project_id = ${complete} AND type = 'blueprint'`,
    );
    conditions = await detectFor(orgId);
    const missing = conditions
      .filter((c) => c.scopeId === complete)
      .map((c) => (c.evidence as { missingDocType: string }).missingDocType);
    expect(missing).toEqual(['blueprint']);
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('ignores non-gathering_signatures projects + archived projects', async () => {
    const orgId = await seedOrg('ignore');
    await seedProject({ orgId, type: 'tama38_1', status: 'planning' });
    await seedProject({ orgId, type: 'tama38_1', status: 'approved' });
    await seedProject({
      orgId,
      type: 'tama38_1',
      status: 'gathering_signatures',
      archived: true,
    });
    const conditions = await detectFor(orgId);
    expect(conditions).toHaveLength(0);
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('the evidence is PII-FREE: no owner/party PII, no contact details; party is DERIVED downstream, not stored', async () => {
    const orgId = await seedOrg('pii');
    await seedProject({
      orgId,
      type: 'tama38_1',
      status: 'gathering_signatures',
    });
    const conditions = await detectFor(orgId);
    expect(conditions.length).toBeGreaterThan(0);
    for (const c of conditions) {
      const ev = c.evidence as Record<string, unknown>;
      // Only the PII-free taxonomy keys — NEVER a party/owner contact or national_id.
      expect(new Set(Object.keys(ev))).toEqual(
        new Set(['condition', 'projectId', 'projectType', 'track', 'missingDocType']),
      );
      // The party is NOT stored in evidence (derived downstream from missingDocType).
      expect(Object.keys(ev)).not.toContain('party');
      const serialized = JSON.stringify(ev);
      expect(serialized).not.toMatch(/national|phone|@|email|nationalId|ownerId/i);
    }
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });
});
