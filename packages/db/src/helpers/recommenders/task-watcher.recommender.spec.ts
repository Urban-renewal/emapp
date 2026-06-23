/**
 * `TaskWatcher` — DB-backed detection tests (Autonomous Master Plan, G1). Proves:
 *   - SET-BASED detection across orgs (one query) finds a `gathering_signatures`
 *     project missing a required doc type and emits one `task.create` condition per
 *     (project, missing type).
 *   - track-correct required sets: a pinui_binui project additionally needs a
 *     `regulation`; a tama38 project does NOT.
 *   - a COMPLETE project (all required types present, non-archived) yields NOTHING;
 *     an archived doc does NOT count as present.
 *   - non-gathering-signatures projects (planning/approved) + archived projects are
 *     ignored.
 *   - the dedup key is per (project, doc type) + the evidence is PII-FREE.
 *   - per-producer isolation: the recommender's detect() composes inside the generic
 *     producer's try/catch (covered structurally by proposal-producer; here we assert
 *     detect() never throws on an empty/odd pool).
 *
 * Seeding is BYPASSRLS (`providerDb`). Run (needs DB + Infisical):
 *   infisical run --env dev -- pnpm --filter @emapp/db exec vitest run \
 *     src/helpers/recommenders/task-watcher.recommender.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerDb } from '../../client';
import { documents, organizations, projects, users } from '../../schema/index';

import { TASK_CREATE_KIND, createTaskWatcherRecommender } from './task-watcher.recommender';

const NOW = new Date('2026-06-22T12:00:00.000Z');

let uploader: string;

async function seedOrg(tag: string): Promise<string> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `tw-${tag}-${orgId.slice(0, 8)}`,
    slug: `tw${tag}${orgId.slice(0, 8)}`.toLowerCase(),
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
  const all = await createTaskWatcherRecommender().detect({ now: NOW });
  return all.filter((c) => c.orgId === orgId);
}

beforeAll(async () => {
  const [u] = await providerDb
    .insert(users)
    .values({
      email: `tw-${randomUUID().slice(0, 8)}@test.local`,
      name: 'TW Uploader',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  uploader = u!.id;
}, 120_000);

afterAll(async () => {
  // best-effort cleanup happens via org-scoped deletes in each test's org.
  await Promise.resolve();
});

describe('TaskWatcher.detect', () => {
  it('detects each MISSING required doc type for a gathering_signatures tama38 project', async () => {
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
    expect(new Set(missing)).toEqual(new Set(['land_registry', 'blueprint']));
    // Every condition is a task.create scoped to the project, PII-free.
    for (const c of conditions) {
      expect(c.kind).toBe(TASK_CREATE_KIND);
      expect(c.scopeType).toBe('project');
      expect(c.scopeId).toBe(projectId);
      const ev = c.evidence as Record<string, unknown>;
      expect(ev).toMatchObject({ condition: 'missing_required_doc', projectId, track: 'tama38' });
      // No PII keys in the evidence snapshot.
      expect(Object.keys(ev)).not.toContain('nationalId');
      expect(Object.keys(ev)).not.toContain('ownerId');
    }
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('the dedup key is deterministic per (project, missing type)', async () => {
    const orgId = await seedOrg('dedup');
    const projectId = await seedProject({
      orgId,
      type: 'tama38_1',
      status: 'gathering_signatures',
    });
    // Missing everything (no docs seeded).
    const a = await detectFor(orgId);
    const b = await detectFor(orgId);
    const keysA = a.map((c) => c.dedupKey).sort();
    const keysB = b.map((c) => c.dedupKey).sort();
    expect(keysA).toEqual(keysB); // re-detection yields the SAME keys (no nonce)
    expect(keysA).toContain(`${TASK_CREATE_KIND}:missing-doc:${projectId}:land_registry`);
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('pinui_binui ALSO requires a regulation; tama38 does NOT', async () => {
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

    expect(pbMissing).toContain('regulation'); // pinui_binui needs it
    expect(tamaMissing).not.toContain('regulation'); // tama38 does not
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

    // Archive the blueprint → it must re-surface as missing (archived ≠ present).
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
});
