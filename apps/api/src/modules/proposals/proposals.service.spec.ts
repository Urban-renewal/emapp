/**
 * Approval-Inbox service spec (Autonomous Master Plan, Phase 1) — against the
 * real local DB.
 *
 * Covers:
 *   - list: PENDING-only, keyset-paginated, ?kind scope filter, RLS-isolated.
 *   - approve: re-asserts classify(kind) at execute time, dispatches to the
 *     registered kind executor (the gated replay), flips → applied + system audit.
 *   - approve fail-closed: an unknown/unexecutable kind cannot apply.
 *   - reject: flips → rejected; releases the dedup key.
 *   - manager-only: a non-manager is FORBIDDEN.
 *   - RLS: org B cannot see / action org A's proposal (generic 404).
 *
 * The SignatureRequestsService dependency is faked: its `reissueAndDeliver`
 * records the (user, {signatureRequestId, proposalId}) it was called with and
 * returns a stub delivery — so this spec proves the PROPOSALS layer's dispatch +
 * state machine + audit + delivery surfacing, while the real `reissueAndDeliver`
 * (re-mint + governed send + notify) is exercised by the signatures suite
 * (signature-requests-reissue-delivers.spec.ts). The proposal rows are seeded via
 * the BYPASSRLS pool, then read/mutated through the service under withTenant/RLS.
 */
import { randomUUID } from 'node:crypto';

import { proposals, providerDb } from '@emapp/db';
import type { CreateTask } from '@emapp/shared-types';
import { ForbiddenException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import type { SignatureRequestsService } from '../signatures/signature-requests.service';
import type { TaskOrigin, TasksService } from '../tasks/tasks.service';

import { ProposalsService } from './proposals.service';

let orgA: TestOrg;
let orgB: TestOrg;
let svc: ProposalsService;

/** Fake SignatureRequestsService — records reissueAndDeliver calls + returns a
 *  stub `delivered` outcome so the approve-response delivery surfacing is asserted
 *  at the proposals layer (the REAL re-mint+send+notify is the signatures suite). */
const reissueCalls: Array<{ orgId: string; scopeId: string; proposalId: string }> = [];
const fakeSignatures = {
  reissueAndDeliver: async (
    user: AccessTokenPayload,
    input: { signatureRequestId: string; proposalId: string },
  ) => {
    reissueCalls.push({
      orgId: user.orgId,
      scopeId: input.signatureRequestId,
      proposalId: input.proposalId,
    });
    return {
      request: { id: input.signatureRequestId } as never,
      delivery: {
        delivered: true,
        state: 'sent' as const,
        channel: 'email' as const,
        recipient: 'na***@test.local',
      },
    };
  },
} as unknown as SignatureRequestsService;

/** Fake TasksService — records create(user, input, origin) calls for the G1
 *  `task.create` executor. Proves the proposals layer replays the gated method
 *  with the system-origin stamp + the PII-free composed copy. */
const taskCreateCalls: Array<{
  orgId: string;
  input: CreateTask;
  origin?: TaskOrigin;
}> = [];
const fakeTasks = {
  create: async (user: AccessTokenPayload, input: CreateTask, origin?: TaskOrigin) => {
    taskCreateCalls.push({ orgId: user.orgId, input, origin });
    return { id: randomUUID() } as never;
  },
} as unknown as TasksService;

function manager(org: TestOrg): AccessTokenPayload {
  return {
    sub: org.users[0]!.id,
    orgId: org.id,
    role: 'manager',
    sid: '00000000-0000-4000-8000-000000000001',
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function viewer(org: TestOrg): AccessTokenPayload {
  return { ...manager(org), role: 'viewer' } as AccessTokenPayload;
}

/** Seed a pending proposal directly (BYPASSRLS). Returns its id. */
async function seedProposal(opts: {
  orgId: string;
  kind: string;
  scopeId?: string;
  dedupKey?: string;
  scopeType?: string;
  evidence?: Record<string, unknown>;
}): Promise<string> {
  const scopeId = opts.scopeId ?? randomUUID();
  const [row] = await providerDb
    .insert(proposals)
    .values({
      orgId: opts.orgId,
      kind: opts.kind,
      status: 'pending',
      scopeType: opts.scopeType ?? 'signature_request',
      scopeId,
      evidence: opts.evidence ?? { signatureRequestId: scopeId, reason: 'expired_unsigned' },
      dedupKey: opts.dedupKey ?? `${opts.kind}:${scopeId}`,
      actorType: 'system',
    })
    .returning({ id: proposals.id });
  return row!.id;
}

async function readStatus(id: string): Promise<string | null> {
  const r = await providerDb.execute<{ status: string }>(
    sql`SELECT status FROM proposals WHERE id = ${id} LIMIT 1`,
  );
  return r.rows[0]?.status ?? null;
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ProposalsService(fakeSignatures, fakeTasks);
  orgA = await createTestOrg(`propa-${Date.now()}`, `propa-${Date.now()}`);
  orgB = await createTestOrg(`propb-${Date.now()}`, `propb-${Date.now()}`);
}, 120_000);

afterAll(async () => {
  await providerDb
    .execute(sql`DELETE FROM proposals WHERE org_id = ${orgA.id}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM proposals WHERE org_id = ${orgB.id}`)
    .catch(() => undefined);
});

describe('ProposalsService.list', () => {
  it('returns only PENDING proposals, with the {data, page} envelope', async () => {
    const pendingId = await seedProposal({ orgId: orgA.id, kind: 'signature_request.reissue' });
    // A non-pending one must NOT appear.
    const appliedId = await seedProposal({ orgId: orgA.id, kind: 'signature_request.reissue' });
    await providerDb.execute(sql`UPDATE proposals SET status = 'applied' WHERE id = ${appliedId}`);

    const page = await svc.list(manager(orgA), { limit: 25 });
    const ids = page.data.map((p) => p.id);
    expect(ids).toContain(pendingId);
    expect(ids).not.toContain(appliedId);
    expect(page.page).toMatchObject({ limit: 25, has_more: expect.any(Boolean) });
    // Evidence comes back verbatim from the snapshot (PII-free shape).
    const row = page.data.find((p) => p.id === pendingId)!;
    expect(row.evidence).toMatchObject({ reason: 'expired_unsigned' });
    expect(row.actorType).toBe('system');
  });

  it('?kind filter narrows to one action kind', async () => {
    const reissue = await seedProposal({ orgId: orgA.id, kind: 'signature_request.reissue' });
    const page = await svc.list(manager(orgA), { limit: 50, kind: 'signature_request.reissue' });
    expect(page.data.every((p) => p.kind === 'signature_request.reissue')).toBe(true);
    expect(page.data.map((p) => p.id)).toContain(reissue);
  });

  it('keyset paginates (limit honored + cursor walks)', async () => {
    // Seed a fresh org to control the count exactly.
    const org = await createTestOrg(`propp-${Date.now()}`, `propp-${Date.now()}`);
    for (let i = 0; i < 3; i++) {
      await seedProposal({ orgId: org.id, kind: 'signature_request.reissue' });
    }
    const first = await svc.list(manager(org), { limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.page.has_more).toBe(true);
    expect(first.page.cursor).toBeTruthy();
    const second = await svc.list(manager(org), { limit: 2, cursor: first.page.cursor! });
    expect(second.data).toHaveLength(1);
    expect(second.page.has_more).toBe(false);
    // No overlap between pages.
    const firstIds = new Set(first.data.map((p) => p.id));
    expect(second.data.every((p) => !firstIds.has(p.id))).toBe(true);
    await providerDb
      .execute(sql`DELETE FROM proposals WHERE org_id = ${org.id}`)
      .catch(() => undefined);
  });

  it('is RLS-isolated: org B does not see org A proposals', async () => {
    const aId = await seedProposal({ orgId: orgA.id, kind: 'signature_request.reissue' });
    const bPage = await svc.list(manager(orgB), { limit: 100 });
    expect(bPage.data.map((p) => p.id)).not.toContain(aId);
  });

  it('a non-manager is FORBIDDEN', async () => {
    await expect(svc.list(viewer(orgA), { limit: 10 })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ProposalsService.pendingCount', () => {
  it('counts ONLY pending proposals (mirrors notifications.unreadCount), org-isolated', async () => {
    // A dedicated org so the count is exact (no bleed from other tests).
    const org = await createTestOrg(`propc-${Date.now()}`, `propc-${Date.now()}`);
    for (let i = 0; i < 3; i++) {
      await seedProposal({ orgId: org.id, kind: 'signature_request.reissue' });
    }
    // A non-pending one must NOT be counted.
    const appliedId = await seedProposal({ orgId: org.id, kind: 'signature_request.reissue' });
    await providerDb.execute(sql`UPDATE proposals SET status = 'applied' WHERE id = ${appliedId}`);

    const { count } = await svc.pendingCount(manager(org));
    expect(count).toBe(3);
    await providerDb
      .execute(sql`DELETE FROM proposals WHERE org_id = ${org.id}`)
      .catch(() => undefined);
  });

  it('is the TRUE total — NOT capped to the list page size (the page-local lie)', async () => {
    // Seed MORE than one page (the FE list pages at 25). The count must report
    // the full magnitude, never the page slice.
    const org = await createTestOrg(`propd-${Date.now()}`, `propd-${Date.now()}`);
    const TOTAL = 30;
    for (let i = 0; i < TOTAL; i++) {
      await seedProposal({ orgId: org.id, kind: 'signature_request.reissue' });
    }
    const firstPage = await svc.list(manager(org), { limit: 25 });
    expect(firstPage.data).toHaveLength(25); // the page is capped …
    const { count } = await svc.pendingCount(manager(org));
    expect(count).toBe(TOTAL); // … but the count is honest.
    await providerDb
      .execute(sql`DELETE FROM proposals WHERE org_id = ${org.id}`)
      .catch(() => undefined);
  });

  it('narrows by ?kind IDENTICALLY to list — count tracks the facet (no "X מתוך Y" drift)', async () => {
    const org = await createTestOrg(`propk-${Date.now()}`, `propk-${Date.now()}`);
    // 3 of kind A, 2 of kind B → org-wide total 5.
    for (let i = 0; i < 3; i++) {
      await seedProposal({ orgId: org.id, kind: 'signature_request.reissue' });
    }
    for (let i = 0; i < 2; i++) {
      await seedProposal({ orgId: org.id, kind: 'document.chase.send' });
    }
    // Unfiltered → the org-wide total.
    expect((await svc.pendingCount(manager(org))).count).toBe(5);
    // Filtered → the count EQUALS the kind-filtered feed length (one kind-aware
    // source: the inbox lead-line + honesty-line + feed can never diverge under a
    // facet — the #545 regression this closes had an org-wide count over a
    // kind-filtered feed → "X מתוך Y" lied).
    const kindA = { kind: 'signature_request.reissue' };
    const feedA = await svc.list(manager(org), { limit: 25, ...kindA });
    expect(feedA.data).toHaveLength(3);
    expect((await svc.pendingCount(manager(org), kindA)).count).toBe(feedA.data.length);
    expect((await svc.pendingCount(manager(org), { kind: 'document.chase.send' })).count).toBe(2);
    await providerDb
      .execute(sql`DELETE FROM proposals WHERE org_id = ${org.id}`)
      .catch(() => undefined);
  });

  it('decrements when a proposal leaves pending (approve / reject)', async () => {
    const org = await createTestOrg(`prope-${Date.now()}`, `prope-${Date.now()}`);
    const a = await seedProposal({ orgId: org.id, kind: 'signature_request.reissue' });
    await seedProposal({ orgId: org.id, kind: 'signature_request.reissue' });
    expect((await svc.pendingCount(manager(org))).count).toBe(2);
    await svc.reject(manager(org), a);
    expect((await svc.pendingCount(manager(org))).count).toBe(1);
    await providerDb
      .execute(sql`DELETE FROM proposals WHERE org_id = ${org.id}`)
      .catch(() => undefined);
  });

  it('is RLS-isolated: org B does not count org A pending proposals', async () => {
    await seedProposal({ orgId: orgA.id, kind: 'signature_request.reissue' });
    const before = (await svc.pendingCount(manager(orgB))).count;
    await seedProposal({ orgId: orgA.id, kind: 'signature_request.reissue' });
    const after = (await svc.pendingCount(manager(orgB))).count;
    expect(after).toBe(before); // org A's new proposal does not move org B's count
  });

  it('a non-manager is FORBIDDEN', async () => {
    await expect(svc.pendingCount(viewer(orgA))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ProposalsService.approve', () => {
  it('re-asserts classify, dispatches to the gated executor, flips → applied + audits', async () => {
    reissueCalls.length = 0;
    const scopeId = randomUUID();
    const id = await seedProposal({ orgId: orgA.id, kind: 'signature_request.reissue', scopeId });

    const view = await svc.approve(manager(orgA), id);
    expect(view.status).toBe('applied');
    expect(view.appliedAt).toBeTruthy();
    // The EXISTING gated method was replayed with the proposal's scopeId + id.
    expect(reissueCalls).toEqual([{ orgId: orgA.id, scopeId, proposalId: id }]);
    expect(await readStatus(id)).toBe('applied');
    // The contact-producing reissue surfaces its delivery OUTCOME on the approve
    // response (so the FE inbox can render "owner re-notified", not nothing).
    expect(view.delivery).toMatchObject({ delivered: true, state: 'sent', channel: 'email' });
    expect(view.delivery?.recipient).toMatch(/\*\*\*@/); // masked, never raw

    // A system-attributed audit row was written carrying the proposal id.
    const audit = await providerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log
            WHERE org_id = ${orgA.id} AND actor_type = 'system'
              AND action = 'proposal.approve' AND target_id = ${id}`,
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('a non-pending proposal cannot be approved (409 conflict)', async () => {
    const id = await seedProposal({ orgId: orgA.id, kind: 'signature_request.reissue' });
    await providerDb.execute(sql`UPDATE proposals SET status = 'rejected' WHERE id = ${id}`);
    await expect(svc.approve(manager(orgA), id)).rejects.toThrow();
  });

  it('G1 task.create: replays gated tasks.create with the system-origin stamp + PII-free composed copy', async () => {
    taskCreateCalls.length = 0;
    const projectId = randomUUID();
    const dedupKey = `task.create:missing-doc:${projectId}:land_registry`;
    const id = await seedProposal({
      orgId: orgA.id,
      kind: 'task.create',
      scopeType: 'project',
      scopeId: projectId,
      dedupKey,
      evidence: {
        condition: 'missing_required_doc',
        projectId,
        projectType: 'tama38_1',
        track: 'tama38',
        missingDocType: 'land_registry',
      },
    });

    const view = await svc.approve(manager(orgA), id);
    expect(view.status).toBe('applied');
    expect(await readStatus(id)).toBe('applied');

    // The EXISTING gated tasks.create was replayed exactly once, scoped to the
    // project, with the SYSTEM-OWNED origin stamp carrying the dedup key.
    expect(taskCreateCalls).toHaveLength(1);
    const call = taskCreateCalls[0]!;
    expect(call.orgId).toBe(orgA.id);
    expect(call.input.projectId).toBe(projectId);
    expect(call.origin).toEqual({ source: 'system', originRef: dedupKey });
    // The composed title/body is PII-free + user-framed (the doc-type label only,
    // never an owner identity); it carries the נסח-טאבו Hebrew label.
    expect(call.input.title).toContain('נסח טאבו');
    expect(call.input.title.toLowerCase()).not.toContain('national');

    // System-attributed audit row for the approve transition.
    const audit = await providerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log
            WHERE org_id = ${orgA.id} AND actor_type = 'system'
              AND action = 'proposal.approve' AND target_id = ${id}`,
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('G1 task.create: a non-manager is FORBIDDEN', async () => {
    const id = await seedProposal({
      orgId: orgA.id,
      kind: 'task.create',
      scopeType: 'project',
      evidence: {
        condition: 'missing_required_doc',
        projectId: randomUUID(),
        projectType: 'tama38_1',
        track: 'tama38',
        missingDocType: 'agreement',
      },
    });
    await expect(svc.approve(viewer(orgA), id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('FAIL-CLOSED: a kind with no registered executor cannot apply', async () => {
    // Seed a proposal whose kind is classifiable but has NO executor registered
    // (a humanOnly floor kind). The boundary re-check passes classify, but the
    // dispatch refuses — nothing is applied.
    reissueCalls.length = 0;
    const id = await seedProposal({ orgId: orgA.id, kind: 'status.toApproved' });
    await expect(svc.approve(manager(orgA), id)).rejects.toThrow();
    expect(reissueCalls).toHaveLength(0);
    expect(await readStatus(id)).toBe('pending'); // untouched
  });

  it('a non-manager is FORBIDDEN', async () => {
    const id = await seedProposal({ orgId: orgA.id, kind: 'signature_request.reissue' });
    await expect(svc.approve(viewer(orgA), id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('RLS: org B cannot approve org A proposal (generic 404)', async () => {
    const id = await seedProposal({ orgId: orgA.id, kind: 'signature_request.reissue' });
    await expect(svc.approve(manager(orgB), id)).rejects.toThrow();
    expect(await readStatus(id)).toBe('pending');
  });
});

describe('ProposalsService.reject', () => {
  it('flips → rejected + audits, and releases the dedup key', async () => {
    const dedupKey = `signature_request.reissue:${randomUUID()}`;
    const id = await seedProposal({ orgId: orgA.id, kind: 'signature_request.reissue', dedupKey });
    const view = await svc.reject(manager(orgA), id);
    expect(view.status).toBe('rejected');
    expect(await readStatus(id)).toBe('rejected');

    // The dedup key is now free — a new pending proposal with the SAME key inserts.
    const [reinsert] = await providerDb
      .insert(proposals)
      .values({
        orgId: orgA.id,
        kind: 'signature_request.reissue',
        status: 'pending',
        scopeType: 'signature_request',
        scopeId: randomUUID(),
        evidence: {},
        dedupKey,
        actorType: 'system',
      })
      .returning({ id: proposals.id });
    expect(reinsert?.id).toBeTruthy();
  });

  it('a non-pending proposal cannot be rejected (409)', async () => {
    const id = await seedProposal({ orgId: orgA.id, kind: 'signature_request.reissue' });
    await providerDb.execute(sql`UPDATE proposals SET status = 'applied' WHERE id = ${id}`);
    await expect(svc.reject(manager(orgA), id)).rejects.toThrow();
  });
});
