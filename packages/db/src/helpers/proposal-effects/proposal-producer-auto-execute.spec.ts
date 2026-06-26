/**
 * Producer AUTO-EXECUTE GRADUATION — DB-backed acceptance tests (Autonomous Master
 * Plan, wave 1.2).
 *
 * Proves the graduation step in `runProposalProducerTick`:
 *   - flag OFF (default) → NOTHING auto-executes: every emitted proposal stays
 *     PENDING (behaviour identical to before wave 1.2).
 *   - flag ON for `task.create` → the proposal is AUTO-APPLIED: a REAL system task
 *     is created (createdBy NULL = no human author), the proposal flips → applied,
 *     and a `proposal.auto_execute` system audit row is written.
 *   - THE BOUNDARY CANNOT BE BYPASSED: even with an OUTBOUND/PII/floor kind FORCED
 *     into the flag, it is NEVER auto-applied — it stays pending (the boundary
 *     re-assert + the AUTO_EXECUTE_SAFE_KINDS allowlist refuse it).
 *   - idempotency: a re-detect of an already-applied condition does not double-apply
 *     (the system-task partial-unique + the dedup no-op).
 *
 * Seeding is BYPASSRLS (`providerDb`); the producer emits + auto-applies inside
 * `withTenant` exactly as in prod.
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=... infisical run --env dev -- \
 *     pnpm --filter @emapp/db exec vitest run \
 *       src/helpers/proposal-effects/proposal-producer-auto-execute.spec.ts
 */
import { randomUUID } from 'node:crypto';

import type { DetectedCondition, IRecommender, RecommenderContext } from '@emapp/jobs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerDb } from '../../client';
import { memberships, organizations, projects, users } from '../../schema/index';
import { runProposalProducerTick, type AutoExecutePolicy } from '../proposal-producer';

let orgId: string;
let creatorId: string;

async function seedOrg(tag: string): Promise<{ orgId: string; creatorId: string }> {
  const id = randomUUID();
  await providerDb.insert(organizations).values({
    id,
    name: `ax-${tag}-${id.slice(0, 8)}`,
    slug: `ax${tag}${id.slice(0, 8)}`.toLowerCase(),
  });
  const [mgr] = await providerDb
    .insert(users)
    .values({
      email: `ax-${tag}-${id.slice(0, 8)}@test.local`,
      name: 'AX Manager',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await providerDb.insert(memberships).values({
    userId: mgr!.id,
    orgId: id,
    role: 'manager',
    isPrimary: true,
    acceptedAt: new Date(),
  });
  return { orgId: id, creatorId: mgr!.id };
}

async function seedProject(): Promise<string> {
  const [proj] = await providerDb
    .insert(projects)
    .values({
      orgId,
      name: `ax-proj-${Date.now()}-${Math.random()}`,
      type: 'tama38_1',
      status: 'gathering_signatures',
      createdBy: creatorId,
    })
    .returning({ id: projects.id });
  return proj!.id;
}

/** A fake recommender that emits exactly the conditions it is given (set-based). */
function fakeRecommender(id: string, conditions: DetectedCondition[]): IRecommender {
  return { id, detect: async (_ctx: RecommenderContext) => conditions };
}

function taskCreateCondition(projectId: string, docType = 'land_registry'): DetectedCondition {
  return {
    orgId,
    kind: 'task.create',
    scopeType: 'project',
    scopeId: projectId,
    evidence: {
      condition: 'missing_required_doc',
      projectId,
      projectType: 'tama38_1',
      track: 'tama38',
      missingDocType: docType,
    },
    dedupKey: `task.create:missing-doc:${projectId}:${docType}`,
  };
}

const ctx: RecommenderContext = { now: new Date() };
const FLAG_OFF: AutoExecutePolicy = { enabledKinds: new Set() };
const FLAG_ON_TASK: AutoExecutePolicy = { enabledKinds: new Set(['task.create']) };

async function proposalStatus(dedupKey: string): Promise<string | null> {
  const r = await providerDb.execute<{ status: string }>(
    sql`SELECT status FROM proposals WHERE org_id = ${orgId} AND dedup_key = ${dedupKey} LIMIT 1`,
  );
  return r.rows[0]?.status ?? null;
}

async function systemTaskFor(originRef: string): Promise<{ created_by: string | null } | null> {
  const r = await providerDb.execute<{ created_by: string | null }>(
    sql`SELECT created_by FROM tasks WHERE org_id = ${orgId} AND origin_ref = ${originRef} AND source = 'system' LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

beforeAll(async () => {
  ({ orgId, creatorId } = await seedOrg('axe'));
}, 120_000);

afterAll(async () => {
  await providerDb.execute(sql`DELETE FROM tasks WHERE org_id = ${orgId}`).catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM proposals WHERE org_id = ${orgId}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM audit_log WHERE org_id = ${orgId}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM projects WHERE org_id = ${orgId}`)
    .catch(() => undefined);
});

describe('producer auto-execute graduation', () => {
  it('flag OFF (default) → proposal stays PENDING, NO task, NO auto-apply', async () => {
    const projectId = await seedProject();
    const cond = taskCreateCondition(projectId);
    const result = await runProposalProducerTick(
      [fakeRecommender('fake-task', [cond])],
      ctx,
      undefined,
      FLAG_OFF,
    );

    expect(result.totalEmitted).toBe(1);
    expect(result.totalAutoApplied).toBe(0);
    expect(await proposalStatus(cond.dedupKey)).toBe('pending');
    expect(await systemTaskFor(cond.dedupKey)).toBeNull();
  });

  it('flag ON for task.create → AUTO-APPLIED: real system task (no human author) + applied + audit', async () => {
    const projectId = await seedProject();
    const cond = taskCreateCondition(projectId);
    const result = await runProposalProducerTick(
      [fakeRecommender('fake-task', [cond])],
      ctx,
      undefined,
      FLAG_ON_TASK,
    );

    expect(result.totalEmitted).toBe(1);
    expect(result.totalAutoApplied).toBe(1);
    // The proposal was applied (not left pending in the inbox).
    expect(await proposalStatus(cond.dedupKey)).toBe('applied');
    // A REAL system task exists with NULL created_by (autonomous, no human author).
    const task = await systemTaskFor(cond.dedupKey);
    expect(task).not.toBeNull();
    expect(task!.created_by).toBeNull();
    // The autonomous act is audited as a pure-system act (null actor).
    const audit = await providerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log
            WHERE org_id = ${orgId} AND actor_type = 'system'
              AND action = 'proposal.auto_execute' AND actor_id IS NULL`,
    );
    expect(audit.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it('BOUNDARY: an OUTBOUND kind FORCED into the flag is NEVER auto-applied (stays pending)', async () => {
    const projectId = await seedProject();
    const dedupKey = `document.chase.send:${projectId}:land_registry`;
    const outboundCond: DetectedCondition = {
      orgId,
      kind: 'document.chase.send', // outbound → can NEVER auto-execute
      scopeType: 'project',
      scopeId: projectId,
      evidence: { condition: 'missing_required_doc', projectId, missingDocType: 'land_registry' },
      dedupKey,
    };
    // Force EVERY conceivably-dangerous kind ON in the flag — the boundary must still refuse.
    const forced: AutoExecutePolicy = {
      enabledKinds: new Set([
        'document.chase.send',
        'reminder.send',
        'signature_request.reissue',
        'nationalId.export',
        'status.toApproved',
      ]),
    };
    const result = await runProposalProducerTick(
      [fakeRecommender('fake-outbound', [outboundCond])],
      ctx,
      undefined,
      forced,
    );

    expect(result.totalEmitted).toBe(1);
    expect(result.totalAutoApplied).toBe(0); // refused
    expect(await proposalStatus(dedupKey)).toBe('pending'); // still in the inbox for a human
  });

  it('idempotency: a re-detect of an applied condition NEVER creates a second task', async () => {
    const projectId = await seedProject();
    const cond = taskCreateCondition(projectId, 'agreement');
    // First tick auto-applies → one system task.
    const first = await runProposalProducerTick(
      [fakeRecommender('fake-task', [cond])],
      ctx,
      undefined,
      FLAG_ON_TASK,
    );
    expect(first.totalAutoApplied).toBe(1);
    expect(await proposalStatus(cond.dedupKey)).toBe('applied');

    // Second tick re-detects the SAME condition (a degenerate fake recommender that
    // ignores the open system task — the real task-watcher would NOT re-detect it).
    // The dedup key releases once the first proposal is terminal, so a NEW pending
    // proposal CAN be emitted — but the EFFECT is idempotent: the system-task
    // partial-unique makes the second insert a DEDUP NO-OP, so NO second task is
    // created. The domain mutation cannot double-apply, which is the real guarantee.
    await runProposalProducerTick(
      [fakeRecommender('fake-task', [cond])],
      ctx,
      undefined,
      FLAG_ON_TASK,
    );
    const taskCount = await providerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tasks WHERE org_id = ${orgId} AND origin_ref = ${cond.dedupKey}`,
    );
    expect(taskCount.rows[0]?.n).toBe(1); // EXACTLY one — never doubled
  });
});
