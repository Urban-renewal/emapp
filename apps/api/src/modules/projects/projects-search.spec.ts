/**
 * NS1 (server-side search, MASTER-PLAN-V13 Wave B) — projects-list search.
 *
 * Asserts the additive `q` / `status` / `segment` filters on
 * `ProjectsService.list`, against the REAL local DB (the predicates run in SQL
 * with RLS + the agent assignment join — mocking would defeat the point).
 *
 * THE CONTRACT under test:
 *  - q match: `q` restricts to projects whose NAME contains the substring
 *    (case-insensitive); a non-matching project is absent.
 *  - empty q = unchanged: with no q/status/segment the result equals the
 *    pre-NS1 list (all active projects, keyset order).
 *  - status: `status` restricts to that exact D.18 status.
 *  - segment 'mine': restricts to the caller's actively-assigned projects.
 *  - RLS isolation: org-A's manager never sees org-B's project via q.
 *  - keyset cursor: limit=1 over ≥2 matches → has_more + cursor; following the
 *    cursor returns the next match with no duplicate.
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/projects/projects-search.spec.ts
 */
import { randomUUID } from 'node:crypto';

import {
  db,
  memberships,
  projectAssignments,
  projects,
  users,
  withTenant,
} from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsService } from './projects.service';

let svc: ProjectsService;
let orgA: TestOrg;
let orgB: TestOrg;
let mgrAId: string;
let mgrBId: string;
let agentAId: string;

const TAG = `srch-${randomUUID().slice(0, 8)}`;

function managerA(): AccessTokenPayload {
  return { sub: mgrAId, orgId: orgA.id, role: 'manager', sid: randomUUID(), type: 'access' } as unknown as AccessTokenPayload;
}
function managerB(): AccessTokenPayload {
  return { sub: mgrBId, orgId: orgB.id, role: 'manager', sid: randomUUID(), type: 'access' } as unknown as AccessTokenPayload;
}
function agentA(): AccessTokenPayload {
  return { sub: agentAId, orgId: orgA.id, role: 'agent', sid: randomUUID(), type: 'access' } as unknown as AccessTokenPayload;
}

async function seedProject(
  orgId: string,
  createdBy: string,
  name: string,
  status: 'planning' | 'gathering_signatures' = 'planning',
): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [p] = await tx
      .insert(projects)
      .values({ orgId, name, type: 'tama38_1', status, createdBy })
      .returning({ id: projects.id });
    return p!.id;
  });
}

async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `ag-${randomUUID()}@test.local`, name: 'Ag', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db.insert(memberships).values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ProjectsService();
  orgA = await createTestOrg(`SrchA-${TAG}`);
  orgB = await createTestOrg(`SrchB-${TAG}`);
  mgrAId = orgA.users[0]!.id;
  mgrBId = orgB.users[0]!.id;
  agentAId = await seedAgent(orgA.id);
}, 60_000);

afterAll(async () => {
  // best-effort cleanup of our tagged projects (RLS-bypassing teardown is
  // unnecessary — leaving rows is harmless for other suites since they filter
  // by their own tags).
});

describe('NS1 projects search', () => {
  it('q matches projects by name substring (case-insensitive); non-match absent', async () => {
    const hitName = `Marom Tower ${TAG}`;
    const missName = `Hidden Block ${TAG}`;
    await seedProject(orgA.id, mgrAId, hitName);
    await seedProject(orgA.id, mgrAId, missName);

    const res = await svc.list(managerA(), { limit: 100, q: 'marom' });
    const names = res.data.map((p) => p.name);
    expect(names).toContain(hitName);
    expect(names).not.toContain(missName);
  });

  it('empty q/status/segment returns the unchanged active list (includes seeded)', async () => {
    const name = `Plain ${TAG}-${randomUUID().slice(0, 6)}`;
    await seedProject(orgA.id, mgrAId, name);
    const res = await svc.list(managerA(), { limit: 100 });
    expect(res.data.map((p) => p.name)).toContain(name);
    // page shape intact
    expect(res.page).toHaveProperty('limit', 100);
    expect(res.page).toHaveProperty('has_more');
  });

  it('status filter restricts to the exact D.18 status', async () => {
    const gathering = `Gathering ${TAG}-${randomUUID().slice(0, 6)}`;
    const planning = `Planning ${TAG}-${randomUUID().slice(0, 6)}`;
    await seedProject(orgA.id, mgrAId, gathering, 'gathering_signatures');
    await seedProject(orgA.id, mgrAId, planning, 'planning');

    const res = await svc.list(managerA(), { limit: 100, q: TAG, status: 'gathering_signatures' });
    const names = res.data.map((p) => p.name);
    expect(names).toContain(gathering);
    expect(names).not.toContain(planning);
    // every returned row actually has the requested status
    expect(res.data.every((p) => p.status === 'gathering_signatures')).toBe(true);
  });

  it("segment 'mine' restricts to the caller's actively-assigned projects (agent)", async () => {
    const assigned = await seedProject(orgA.id, mgrAId, `Assigned ${TAG}-${randomUUID().slice(0, 6)}`);
    const unassigned = await seedProject(orgA.id, mgrAId, `Unassigned ${TAG}-${randomUUID().slice(0, 6)}`);
    await db.insert(projectAssignments).values({ projectId: assigned, userId: agentAId, assignedBy: mgrAId });

    const res = await svc.list(agentA(), { limit: 100, segment: 'mine' });
    const ids = res.data.map((p) => p.id);
    expect(ids).toContain(assigned);
    expect(ids).not.toContain(unassigned);
  });

  it('RLS isolation: org-A manager never sees org-B project via q', async () => {
    const bName = `OrgB Secret ${TAG}`;
    await seedProject(orgB.id, mgrBId, bName);
    // org-A search for the org-B name → empty
    const fromA = await svc.list(managerA(), { limit: 100, q: 'orgb secret' });
    expect(fromA.data.map((p) => p.name)).not.toContain(bName);
    // org-B manager DOES see it (control)
    const fromB = await svc.list(managerB(), { limit: 100, q: 'orgb secret' });
    expect(fromB.data.map((p) => p.name)).toContain(bName);
  });

  it('keyset cursor over ≥2 q-matches: page1(limit=1) has_more+cursor, page2 no dup', async () => {
    const ks = `Keyset ${TAG}-${randomUUID().slice(0, 6)}`;
    await seedProject(orgA.id, mgrAId, `${ks} One`);
    await seedProject(orgA.id, mgrAId, `${ks} Two`);

    const page1 = await svc.list(managerA(), { limit: 1, q: ks });
    expect(page1.data).toHaveLength(1);
    expect(page1.page.has_more).toBe(true);
    expect(page1.page.cursor).toBeTruthy();

    const page2 = await svc.list(managerA(), { limit: 1, q: ks, cursor: page1.page.cursor! });
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0]!.id).not.toBe(page1.data[0]!.id);
  });

  it('q with a LIKE metacharacter is treated literally (no wildcard injection)', async () => {
    // A project whose name does NOT contain a percent sign must not match a
    // q of "%" (which, unescaped, would be a match-all wildcard).
    const plain = `NoPercent ${TAG}-${randomUUID().slice(0, 6)}`;
    await seedProject(orgA.id, mgrAId, plain);
    const res = await svc.list(managerA(), { limit: 100, q: '%' });
    expect(res.data.map((p) => p.name)).not.toContain(plain);
  });
});
