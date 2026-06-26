/**
 * `permit-expiring` — DB-backed detection tests (wave-2.4 future-states). Proves:
 *   - SET-BASED detection across orgs (one query) finds a LIVE project whose
 *     APPROVED permit is within the window (or already past) and emits one
 *     `task.create` condition per project.
 *   - the window is respected: a permit expiring FAR out (> window) yields NOTHING;
 *     an already-expired one yields a condition flagged `alreadyExpired`.
 *   - only APPROVED permits qualify: applied / rejected / none / expired-status
 *     projects are ignored even with an expiry date.
 *   - terminal (completed/cancelled) + archived projects are ignored;
 *     `in_construction` IS included (a permit can lapse mid-build).
 *   - the dedup key is deterministic per (project, expiry instant) + the evidence
 *     is PII-FREE.
 *
 * Seeding is BYPASSRLS (`providerDb`). Run (needs DB + Infisical):
 *   infisical run --env dev -- pnpm --filter @emapp/db exec vitest run \
 *     src/helpers/recommenders/permit-expiring.recommender.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerDb } from '../../client';
import { organizations, projects, users } from '../../schema/index';

import {
  PERMIT_EXPIRING_TASK_KIND,
  createPermitExpiringRecommender,
} from './permit-expiring.recommender';

const NOW = new Date('2026-06-25T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let creator: string;

async function seedOrg(tag: string): Promise<string> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `pe-${tag}-${orgId.slice(0, 8)}`,
    slug: `pe${tag}${orgId.slice(0, 8)}`.toLowerCase(),
  });
  return orgId;
}

async function seedProject(opts: {
  orgId: string;
  status?:
    | 'planning'
    | 'gathering_signatures'
    | 'approved'
    | 'in_construction'
    | 'completed'
    | 'cancelled';
  permitStatus?: 'none' | 'applied' | 'approved' | 'rejected' | 'expired';
  permitExpiryAt?: Date | null;
  archived?: boolean;
}): Promise<string> {
  const [row] = await providerDb
    .insert(projects)
    .values({
      orgId: opts.orgId,
      name: `proj-${randomUUID().slice(0, 8)}`,
      type: 'tama38_1',
      status: opts.status ?? 'in_construction',
      permitStatus: opts.permitStatus ?? 'approved',
      permitExpiryAt: opts.permitExpiryAt ?? null,
      createdBy: creator,
      archivedAt: opts.archived ? NOW : null,
    })
    .returning({ id: projects.id });
  return row!.id;
}

/** Detect, then return only the conditions for `orgId` (the pool spans all orgs). */
async function detectFor(orgId: string) {
  const all = await createPermitExpiringRecommender().detect({ now: NOW });
  return all.filter((c) => c.orgId === orgId);
}

beforeAll(async () => {
  const [u] = await providerDb
    .insert(users)
    .values({
      email: `pe-${randomUUID().slice(0, 8)}@test.local`,
      name: 'PE Creator',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  creator = u!.id;
}, 120_000);

afterAll(async () => {
  await Promise.resolve();
});

describe('permit-expiring.detect', () => {
  it('fires for an approved permit expiring within the 30-day window', async () => {
    const orgId = await seedOrg('soon');
    const projectId = await seedProject({
      orgId,
      permitExpiryAt: new Date(NOW.getTime() + 10 * DAY), // 10 days out
    });

    const conditions = await detectFor(orgId);
    expect(conditions).toHaveLength(1);
    const c = conditions[0]!;
    expect(c.kind).toBe(PERMIT_EXPIRING_TASK_KIND);
    expect(c.scopeType).toBe('project');
    expect(c.scopeId).toBe(projectId);
    const ev = c.evidence as Record<string, unknown>;
    expect(ev).toMatchObject({ condition: 'permit_expiring', projectId, alreadyExpired: false });
    // PII-free.
    expect(Object.keys(ev)).not.toContain('nationalId');
    expect(Object.keys(ev)).not.toContain('ownerId');
    expect(JSON.stringify(ev)).not.toMatch(/national|phone|@/i);

    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('flags alreadyExpired for a permit already past', async () => {
    const orgId = await seedOrg('past');
    await seedProject({ orgId, permitExpiryAt: new Date(NOW.getTime() - 5 * DAY) });

    const conditions = await detectFor(orgId);
    expect(conditions).toHaveLength(1);
    expect((conditions[0]!.evidence as { alreadyExpired: boolean }).alreadyExpired).toBe(true);

    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('does NOT fire for a permit expiring far beyond the window', async () => {
    const orgId = await seedOrg('far');
    await seedProject({ orgId, permitExpiryAt: new Date(NOW.getTime() + 90 * DAY) });

    const conditions = await detectFor(orgId);
    expect(conditions).toHaveLength(0);

    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('ignores non-approved permit statuses even with an in-window expiry', async () => {
    const orgId = await seedOrg('status');
    const expiry = new Date(NOW.getTime() + 5 * DAY);
    await seedProject({ orgId, permitStatus: 'applied', permitExpiryAt: expiry });
    await seedProject({ orgId, permitStatus: 'rejected', permitExpiryAt: expiry });
    await seedProject({ orgId, permitStatus: 'expired', permitExpiryAt: expiry });
    await seedProject({ orgId, permitStatus: 'none', permitExpiryAt: expiry });

    const conditions = await detectFor(orgId);
    expect(conditions).toHaveLength(0);

    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('ignores terminal + archived projects; includes in_construction', async () => {
    const orgId = await seedOrg('scope');
    const expiry = new Date(NOW.getTime() + 5 * DAY);
    await seedProject({ orgId, status: 'completed', permitExpiryAt: expiry });
    await seedProject({ orgId, status: 'cancelled', permitExpiryAt: expiry });
    await seedProject({ orgId, status: 'in_construction', permitExpiryAt: expiry, archived: true });
    const live = await seedProject({ orgId, status: 'in_construction', permitExpiryAt: expiry });

    const conditions = await detectFor(orgId);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]!.scopeId).toBe(live);

    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });

  it('dedup key is deterministic per (project, expiry instant)', async () => {
    const orgId = await seedOrg('dedup');
    const expiry = new Date(NOW.getTime() + 7 * DAY);
    const projectId = await seedProject({ orgId, permitExpiryAt: expiry });

    const a = await detectFor(orgId);
    const b = await detectFor(orgId);
    expect(a.map((c) => c.dedupKey)).toEqual(b.map((c) => c.dedupKey));
    expect(a[0]!.dedupKey).toBe(
      `${PERMIT_EXPIRING_TASK_KIND}:permit-expiring:${projectId}:${expiry.getTime()}`,
    );

    await providerDb
      .execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      .catch(() => undefined);
  });
});
