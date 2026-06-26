/**
 * 2.6 future-states — DB-backed tests for (a) the ADDITIVE sharpening of the
 * canonical `detectMissingRequiredDocs` and (b) the new `doc-expiry-warn`
 * recommender + `detectExpiringApprovedDocs`.
 *
 * Proves:
 *   A1. ADDITIVE SAFETY — with every 2.6 column NULL, a present required doc
 *       STILL satisfies the requirement (byte-identical to pre-2.6): no gap.
 *   A2. a present required doc explicitly marked legal_status='rejected' NO
 *       LONGER satisfies — the type re-appears as missing.
 *   A3. a present required doc with version_state='superseded' no longer
 *       satisfies.
 *   A4. a present required doc whose valid_until is in the PAST no longer
 *       satisfies; a future valid_until still satisfies.
 *   B1. detectExpiringApprovedDocs finds an approved, current doc on a
 *       gathering-signatures project whose valid_until is within the window.
 *   B2. NOT-approved / superseded / out-of-window / non-gathering / archived
 *       docs are NOT flagged.
 *   B3. the recommender emits a PII-FREE task.create condition with the
 *       doc_expiry discriminator + a deterministic per-document dedup key.
 *
 * Seeding is BYPASSRLS (`providerDb`). Run (needs DB + Infisical):
 *   infisical run --env dev -- bash -c 'export DB_TARGET=local; \
 *     export LOCAL_DATABASE_URL="postgresql://postgres:1234@localhost:5432/emapp_v26?sslmode=disable"; \
 *     pnpm --filter @emapp/db exec vitest run \
 *       src/helpers/recommenders/doc-expiry-warn.recommender.spec.ts'
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerDb } from '../../client';
import { documents, organizations, projects, users } from '../../schema/index';

import {
  DOC_EXPIRY_WARN_WINDOW_DAYS,
  createDocExpiryWarnRecommender,
  detectExpiringApprovedDocs,
} from './doc-expiry-warn.recommender';
import { detectMissingRequiredDocs } from './missing-required-doc.detect';

const NOW = new Date('2026-06-22T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let uploader: string;

async function seedOrg(tag: string): Promise<string> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `de-${tag}-${orgId.slice(0, 8)}`,
    slug: `de${tag}${orgId.slice(0, 8)}`.toLowerCase(),
  });
  return orgId;
}

async function seedProject(opts: {
  orgId: string;
  status?: 'planning' | 'gathering_signatures' | 'approved';
  archived?: boolean;
}): Promise<string> {
  const [row] = await providerDb
    .insert(projects)
    .values({
      orgId: opts.orgId,
      name: `proj-${randomUUID().slice(0, 8)}`,
      type: 'tama38_1',
      status: opts.status ?? 'gathering_signatures',
      createdBy: uploader,
      archivedAt: opts.archived ? NOW : null,
    })
    .returning({ id: projects.id });
  return row!.id;
}

async function seedDoc(opts: {
  orgId: string;
  projectId: string;
  type: string;
  archived?: boolean;
  legalStatus?: 'draft' | 'reviewed' | 'approved' | 'rejected' | null;
  versionState?: 'current' | 'superseded' | null;
  validUntil?: Date | null;
  notaryStatus?: 'none' | 'required' | 'notarized' | null;
}): Promise<string> {
  const [row] = await providerDb
    .insert(documents)
    .values({
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
      legalStatus: opts.legalStatus ?? null,
      versionState: opts.versionState ?? null,
      validUntil: opts.validUntil ?? null,
      notaryStatus: opts.notaryStatus ?? null,
    })
    .returning({ id: documents.id });
  return row!.id;
}

/** The three tama38 required types — a complete set so the project is otherwise satisfied. */
async function seedCompleteRequiredSet(
  orgId: string,
  projectId: string,
  overrides: Parameters<typeof seedDoc>[0][] = [],
) {
  const types = ['agreement', 'land_registry', 'blueprint'];
  const overrideByType = new Map(overrides.map((o) => [o.type, o]));
  for (const type of types) {
    const o = overrideByType.get(type);
    await seedDoc({ orgId, projectId, type, ...(o ?? {}) });
  }
}

async function missingTypesFor(orgId: string): Promise<Set<string>> {
  const gaps = await detectMissingRequiredDocs();
  return new Set(gaps.filter((g) => g.orgId === orgId).map((g) => g.missingDocType));
}

beforeAll(async () => {
  const [u] = await providerDb
    .insert(users)
    .values({
      email: `de-${randomUUID().slice(0, 8)}@test.local`,
      name: 'DE Uploader',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  uploader = u!.id;
}, 120_000);

afterAll(async () => {
  await Promise.resolve();
});

describe('2.6 — detectMissingRequiredDocs additive sharpening', () => {
  it('A1) all-NULL 2.6 columns ⇒ a present required doc STILL satisfies (no regression)', async () => {
    const orgId = await seedOrg('a1');
    const projectId = await seedProject({ orgId });
    await seedCompleteRequiredSet(orgId, projectId); // every 2.6 col NULL
    expect(await missingTypesFor(orgId)).toEqual(new Set());
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('A2) a legal_status=rejected required doc no longer satisfies (re-appears as missing)', async () => {
    const orgId = await seedOrg('a2');
    const projectId = await seedProject({ orgId });
    await seedCompleteRequiredSet(orgId, projectId, [
      { orgId, projectId, type: 'land_registry', legalStatus: 'rejected' },
    ]);
    expect(await missingTypesFor(orgId)).toEqual(new Set(['land_registry']));
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('A3) a version_state=superseded required doc no longer satisfies', async () => {
    const orgId = await seedOrg('a3');
    const projectId = await seedProject({ orgId });
    await seedCompleteRequiredSet(orgId, projectId, [
      { orgId, projectId, type: 'blueprint', versionState: 'superseded' },
    ]);
    expect(await missingTypesFor(orgId)).toEqual(new Set(['blueprint']));
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('A4) an EXPIRED required doc no longer satisfies; a FUTURE valid_until still does', async () => {
    const orgId = await seedOrg('a4');
    const projectId = await seedProject({ orgId });
    await seedCompleteRequiredSet(orgId, projectId, [
      { orgId, projectId, type: 'agreement', validUntil: new Date(Date.now() - 5 * DAY) },
      { orgId, projectId, type: 'land_registry', validUntil: new Date(Date.now() + 90 * DAY) },
    ]);
    // Only the expired one re-appears.
    expect(await missingTypesFor(orgId)).toEqual(new Set(['agreement']));
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });
});

describe('2.6 — detectExpiringApprovedDocs + doc-expiry-warn recommender', () => {
  it('B1) flags an approved, current doc expiring within the window', async () => {
    const orgId = await seedOrg('b1');
    const projectId = await seedProject({ orgId });
    const docId = await seedDoc({
      orgId,
      projectId,
      type: 'land_registry',
      legalStatus: 'approved',
      validUntil: new Date(NOW.getTime() + 10 * DAY),
    });
    const rows = (await detectExpiringApprovedDocs(NOW, DOC_EXPIRY_WARN_WINDOW_DAYS)).filter(
      (r) => r.orgId === orgId,
    );
    expect(rows.map((r) => r.documentId)).toEqual([docId]);
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('B2) does NOT flag not-approved / superseded / out-of-window / archived / non-gathering', async () => {
    const orgId = await seedOrg('b2');
    const gathering = await seedProject({ orgId, status: 'gathering_signatures' });
    const approvedProj = await seedProject({ orgId, status: 'approved' });
    // not approved (reviewed) — skip
    await seedDoc({
      orgId,
      projectId: gathering,
      type: 'agreement',
      legalStatus: 'reviewed',
      validUntil: new Date(NOW.getTime() + 5 * DAY),
    });
    // approved but superseded — skip
    await seedDoc({
      orgId,
      projectId: gathering,
      type: 'blueprint',
      legalStatus: 'approved',
      versionState: 'superseded',
      validUntil: new Date(NOW.getTime() + 5 * DAY),
    });
    // approved but out of window (60d) — skip
    await seedDoc({
      orgId,
      projectId: gathering,
      type: 'land_registry',
      legalStatus: 'approved',
      validUntil: new Date(NOW.getTime() + 60 * DAY),
    });
    // approved + in-window but ARCHIVED — skip
    await seedDoc({
      orgId,
      projectId: gathering,
      type: 'permit',
      legalStatus: 'approved',
      validUntil: new Date(NOW.getTime() + 5 * DAY),
      archived: true,
    });
    // approved + in-window but project is NOT gathering_signatures — skip
    await seedDoc({
      orgId,
      projectId: approvedProj,
      type: 'agreement',
      legalStatus: 'approved',
      validUntil: new Date(NOW.getTime() + 5 * DAY),
    });

    const rows = (await detectExpiringApprovedDocs(NOW, DOC_EXPIRY_WARN_WINDOW_DAYS)).filter(
      (r) => r.orgId === orgId,
    );
    expect(rows).toEqual([]);
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('B3) the recommender emits a PII-FREE doc_expiry condition with a deterministic key', async () => {
    const orgId = await seedOrg('b3');
    const projectId = await seedProject({ orgId });
    const docId = await seedDoc({
      orgId,
      projectId,
      type: 'land_registry',
      legalStatus: 'approved',
      validUntil: new Date(NOW.getTime() + 7 * DAY),
    });
    const conditions = (await createDocExpiryWarnRecommender().detect({ now: NOW })).filter(
      (c) => c.orgId === orgId,
    );
    expect(conditions).toHaveLength(1);
    const c = conditions[0]!;
    expect(c.kind).toBe('task.create');
    expect(c.scopeType).toBe('project');
    expect(c.scopeId).toBe(projectId);
    expect(c.dedupKey).toBe(`task.create:doc-expiry:${docId}`);
    const ev = c.evidence as Record<string, unknown>;
    expect(ev).toMatchObject({
      condition: 'doc_expiry',
      projectId,
      documentId: docId,
      docType: 'land_registry',
    });
    // PII-FREE.
    expect(Object.keys(ev)).not.toContain('nationalId');
    expect(Object.keys(ev)).not.toContain('ownerId');
    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });
});
