/**
 * Autonomy Phase-1 PROPOSAL SPINE — DB-backed acceptance tests.
 *
 * Covers (the foundation slice's required tests):
 *   - emitProposal: dedup IDEMPOTENCY (the partial-unique no-op), UNKNOWN-kind
 *     throw (fail-closed taxonomy), and the EVIDENCE SNAPSHOT at emit.
 *   - the signature-reissue recommender: SET-BASED detection across orgs + the
 *     lookback window + the deterministic dedup-key contract.
 *   - the generic ProposalProducer: per-tenant emit + PER-PRODUCER ISOLATION
 *     (a throwing recommender doesn't drop the others).
 *
 * Seeding is BYPASSRLS (`providerDb`) — the renter/doc-taxonomy spec template.
 * emitProposal itself runs inside `withTenant` (RLS-scoped) exactly as the
 * producer calls it.
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=... infisical run --env dev -- \
 *     pnpm --filter @emapp/db exec vitest run src/helpers/proposals.spec.ts
 */
import { randomUUID } from 'node:crypto';

import type { DetectedCondition, IRecommender, RecommenderContext } from '@emapp/jobs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerDb } from '../client';
import {
  apartments,
  buildings,
  organizations,
  owners,
  projects,
  users,
  memberships,
} from '../schema/index';
import { withTenant } from '../wrappers/with-tenant';

import { runProposalProducerTick } from './proposal-producer';
import { emitProposal } from './proposals';
import {
  createSignatureReissueRecommender,
  SIGNATURE_REISSUE_KIND,
} from './recommenders/signature-reissue.recommender';

let orgA: string;
let orgB: string;
let creatorAId: string;
let creatorBId: string;

async function seedOrg(tag: string): Promise<{ orgId: string; creatorId: string }> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `prop-${tag}-${orgId.slice(0, 8)}`,
    slug: `prop${tag}${orgId.slice(0, 8)}`.toLowerCase(),
  });
  const [mgr] = await providerDb
    .insert(users)
    .values({
      email: `prop-${tag}-${orgId.slice(0, 8)}@test.local`,
      name: 'Prop Manager',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await providerDb.insert(memberships).values({
    userId: mgr!.id,
    orgId,
    role: 'manager',
    isPrimary: true,
    acceptedAt: new Date(),
  });
  return { orgId, creatorId: mgr!.id };
}

/** Seed the FULL FK chain a signature_request needs (building→apt→doc + owner)
 *  and the request itself with the given status + expires_at. Returns the
 *  request id. BYPASSRLS raw SQL so RLS doesn't obstruct the cross-cutting seed. */
async function seedSignatureRequest(opts: {
  orgId: string;
  creatorId: string;
  status: 'pending' | 'signed' | 'cancelled' | 'expired';
  expiresAt: Date;
}): Promise<string> {
  const [proj] = await providerDb
    .insert(projects)
    .values({
      orgId: opts.orgId,
      name: `prop-proj-${Date.now()}-${Math.random()}`,
      type: 'tama38_1',
      createdBy: opts.creatorId,
    })
    .returning({ id: projects.id });
  const [bld] = await providerDb
    .insert(buildings)
    .values({ projectId: proj!.id, address: `prop ${Date.now()}-${Math.random()}`, city: 'TLV' })
    .returning({ id: buildings.id });
  const [apt] = await providerDb
    .insert(apartments)
    .values({ buildingId: bld!.id, number: `P-${Date.now()}-${Math.random()}` })
    .returning({ id: apartments.id });
  const [own] = await providerDb
    .insert(owners)
    .values({ orgId: opts.orgId })
    .returning({ id: owners.id });

  const docRes = await providerDb.execute<{ id: string }>(sql`
    INSERT INTO documents
      (org_id, project_id, apartment_id, name, type, mime_type, size_bytes,
       r2_key, content_hash, uploaded_by)
    VALUES
      (${opts.orgId}, NULL, ${apt!.id}, 'sig.pdf', 'other', 'application/pdf', 100,
       ${`org/${opts.orgId}/doc/${randomUUID()}`}, 'h', ${opts.creatorId})
    RETURNING id
  `);
  const docId = docRes.rows[0]!.id;

  const reqRes = await providerDb.execute<{ id: string }>(sql`
    INSERT INTO signature_requests
      (org_id, document_id, owner_id, jti, status, expires_at, created_by)
    VALUES
      (${opts.orgId}, ${docId}, ${own!.id}, ${randomUUID()}, ${opts.status},
       ${opts.expiresAt.toISOString()}, ${opts.creatorId})
    RETURNING id
  `);
  return reqRes.rows[0]!.id;
}

async function countPending(orgId: string): Promise<number> {
  const r = await providerDb.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM proposals WHERE org_id = ${orgId} AND status = 'pending'`,
  );
  return r.rows[0]?.n ?? 0;
}

async function cleanup(orgId: string): Promise<void> {
  await providerDb
    .execute(sql`DELETE FROM proposals WHERE org_id = ${orgId}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM signature_requests WHERE org_id = ${orgId}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM documents WHERE org_id = ${orgId}`)
    .catch(() => undefined);
  await providerDb
    .delete(owners)
    .where(eq(owners.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => undefined);
}

beforeAll(async () => {
  const a = await seedOrg('a');
  const b = await seedOrg('b');
  orgA = a.orgId;
  creatorAId = a.creatorId;
  orgB = b.orgId;
  creatorBId = b.creatorId;
}, 120_000);

afterAll(async () => {
  await cleanup(orgA);
  await cleanup(orgB);
});

describe('emitProposal', () => {
  it('inserts a pending proposal and snapshots evidence verbatim', async () => {
    const scopeId = randomUUID();
    const dedupKey = `signature_request.reissue:${scopeId}`;
    const res = await withTenant(orgA, (tx) =>
      emitProposal(tx, {
        orgId: orgA,
        kind: SIGNATURE_REISSUE_KIND,
        scopeType: 'signature_request',
        scopeId,
        evidence: { signatureRequestId: scopeId, expiredAt: '2026-06-01T00:00:00.000Z' },
        dedupKey,
      }),
    );
    expect(res.inserted).toBe(true);
    expect(res.proposal?.status).toBe('pending');
    expect(res.proposal?.actorType).toBe('system');
    // Evidence is stored VERBATIM (the snapshot, not recomputed).
    expect(res.proposal?.evidence).toEqual({
      signatureRequestId: scopeId,
      expiredAt: '2026-06-01T00:00:00.000Z',
    });
  });

  it('is IDEMPOTENT — a second live emit for the same dedup_key is a no-op', async () => {
    const scopeId = randomUUID();
    const dedupKey = `signature_request.reissue:${scopeId}`;
    const first = await withTenant(orgA, (tx) =>
      emitProposal(tx, {
        orgId: orgA,
        kind: SIGNATURE_REISSUE_KIND,
        scopeType: 'signature_request',
        scopeId,
        evidence: { signatureRequestId: scopeId },
        dedupKey,
      }),
    );
    const second = await withTenant(orgA, (tx) =>
      emitProposal(tx, {
        orgId: orgA,
        kind: SIGNATURE_REISSUE_KIND,
        scopeType: 'signature_request',
        scopeId,
        evidence: { signatureRequestId: scopeId, changed: true },
        dedupKey,
      }),
    );
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    // The no-op returns the EXISTING row (original evidence, not the second call's).
    expect(second.proposal?.id).toBe(first.proposal?.id);
    expect(second.proposal?.evidence).toEqual({ signatureRequestId: scopeId });
  });

  it('releases the dedup key once the proposal leaves pending (can re-propose)', async () => {
    const scopeId = randomUUID();
    const dedupKey = `signature_request.reissue:${scopeId}`;
    const first = await withTenant(orgA, (tx) =>
      emitProposal(tx, {
        orgId: orgA,
        kind: SIGNATURE_REISSUE_KIND,
        scopeType: 'signature_request',
        scopeId,
        evidence: {},
        dedupKey,
      }),
    );
    // Reject it (leaves pending) — the partial-unique releases the key.
    await providerDb.execute(
      sql`UPDATE proposals SET status = 'rejected' WHERE id = ${first.proposal!.id}`,
    );
    const second = await withTenant(orgA, (tx) =>
      emitProposal(tx, {
        orgId: orgA,
        kind: SIGNATURE_REISSUE_KIND,
        scopeType: 'signature_request',
        scopeId,
        evidence: {},
        dedupKey,
      }),
    );
    expect(second.inserted).toBe(true);
    expect(second.proposal?.id).not.toBe(first.proposal?.id);
  });

  it('THROWS on an unknown kind (fail-closed taxonomy) — no row written', async () => {
    const scopeId = randomUUID();
    const before = await countPending(orgA);
    await expect(
      withTenant(orgA, (tx) =>
        emitProposal(tx, {
          // Force an unknown kind past the type system to prove the runtime guard.
          kind: 'totally.unknown.kind' as never,
          orgId: orgA,
          scopeType: 'signature_request',
          scopeId,
          evidence: {},
          dedupKey: `x:${scopeId}`,
        }),
      ),
    ).rejects.toThrow();
    expect(await countPending(orgA)).toBe(before);
  });
});

describe('SignatureReissueRecommender (set-based detection)', () => {
  it('detects ONLY expired, in-window requests — across orgs, in one query', async () => {
    const now = new Date('2026-06-22T12:00:00.000Z');
    // orgA: an expired request 5 days ago (IN window) → detected.
    const reqExpiredA = await seedSignatureRequest({
      orgId: orgA,
      creatorId: creatorAId,
      status: 'expired',
      expiresAt: new Date('2026-06-17T12:00:00.000Z'),
    });
    // orgB: an expired request 2 days ago (IN window, DIFFERENT org) → detected.
    const reqExpiredB = await seedSignatureRequest({
      orgId: orgB,
      creatorId: creatorBId,
      status: 'expired',
      expiresAt: new Date('2026-06-20T12:00:00.000Z'),
    });
    // orgA: a PENDING (not-yet-swept) request → NOT detected.
    await seedSignatureRequest({
      orgId: orgA,
      creatorId: creatorAId,
      status: 'pending',
      expiresAt: new Date('2026-07-01T12:00:00.000Z'),
    });
    // orgA: an expired request 90 days ago (OUT of the 30-day window) → NOT detected.
    await seedSignatureRequest({
      orgId: orgA,
      creatorId: creatorAId,
      status: 'expired',
      expiresAt: new Date('2026-03-15T12:00:00.000Z'),
    });

    const rec = createSignatureReissueRecommender();
    const conditions = await rec.detect({ now });
    const detectedIds = conditions.map((c) => c.scopeId);

    expect(detectedIds).toContain(reqExpiredA);
    expect(detectedIds).toContain(reqExpiredB);
    // Each carries the deterministic dedup key + PII-free evidence.
    const condA = conditions.find((c) => c.scopeId === reqExpiredA)!;
    expect(condA.kind).toBe(SIGNATURE_REISSUE_KIND);
    expect(condA.dedupKey).toBe(`${SIGNATURE_REISSUE_KIND}:${reqExpiredA}`);
    expect(condA.evidence).toMatchObject({
      signatureRequestId: reqExpiredA,
      reason: 'expired_unsigned',
    });
    // The conditions span BOTH orgs from ONE detect() call (set-based).
    const orgsDetected = new Set(conditions.map((c) => c.orgId));
    expect(orgsDetected.has(orgA)).toBe(true);
    expect(orgsDetected.has(orgB)).toBe(true);
  });
});

describe('runProposalProducerTick', () => {
  it('emits per-tenant proposals + is idempotent across ticks', async () => {
    const now = new Date('2026-06-22T12:00:00.000Z');
    const rec = createSignatureReissueRecommender();

    const first = await runProposalProducerTick([rec], { now });
    // Re-run the SAME tick — every condition dedups to a no-op.
    const second = await runProposalProducerTick([rec], { now });

    expect(first.totalEmitted).toBeGreaterThan(0);
    expect(second.totalEmitted).toBe(0);
    const r2 = second.results[0]!;
    expect(r2.deduped).toBeGreaterThan(0);
    expect(r2.emitted).toBe(0);
  });

  it('PER-PRODUCER ISOLATION — a throwing recommender never drops the others', async () => {
    const now = new Date('2026-06-22T12:00:00.000Z');
    const boom: IRecommender = {
      id: 'boom',
      detect: async (): Promise<DetectedCondition[]> => {
        throw new Error('detect exploded');
      },
    };
    const good: IRecommender = {
      id: 'good',
      detect: async (ctx: RecommenderContext): Promise<DetectedCondition[]> => {
        const scopeId = randomUUID();
        return [
          {
            orgId: orgA,
            kind: SIGNATURE_REISSUE_KIND,
            scopeType: 'signature_request',
            scopeId,
            evidence: { signatureRequestId: scopeId, at: ctx.now.toISOString() },
            dedupKey: `${SIGNATURE_REISSUE_KIND}:${scopeId}`,
          },
        ];
      },
    };

    const before = await countPending(orgA);
    // boom FIRST so we prove a failure does not abort the rest.
    const res = await runProposalProducerTick([boom, good], { now });

    const boomResult = res.results.find((r) => r.recommenderId === 'boom')!;
    const goodResult = res.results.find((r) => r.recommenderId === 'good')!;
    expect(boomResult.detectFailed).toBe(true);
    expect(goodResult.detectFailed).toBe(false);
    expect(goodResult.emitted).toBe(1);
    // The good recommender's proposal landed despite boom throwing.
    expect(await countPending(orgA)).toBe(before + 1);
  });
});
