/**
 * B-PROVIDER-2 — `GET /provider/audit/self` provider SELF-audit reader.
 *
 * `ProviderAuditService.selfSearch(actor, reason, query)` reads the
 * PROVIDER'S OWN action log (`provider_audit_log`) — the table where
 * every cross-tenant provider access is recorded — distinct from the
 * customers' `audit_log` that `search()` reads.
 *
 * Real-DB harness (mirrors provider-audit.spec.ts):
 *   - seed `provider_audit_log` rows DIRECTLY via providerPool (BYPASSRLS)
 *     so we control action_type / started_at / affected_orgs exactly;
 *   - call `svc.selfSearch(principal(), reason, query)`;
 *   - query providerPool for ground-truth (incl. the self-audit row the
 *     read itself writes).
 *
 * Pollution defence: the service reads the WHOLE table for the provider
 * (no provider_user_id predicate), and it WRITES its own
 * `provider.self_audit.searched` rows under the SAME provider user — so
 * every read appends a row that subsequent reads see. We therefore scope
 * every assertion to our seeded ids (`ourIds`) / a per-run marker on
 * action_type, never to raw counts.
 *
 * Test IDs:
 *   BP2-1a  no filters → our seeds returned, ordered started_at DESC
 *   BP2-1b  field projection — every ProviderSelfAuditItem field maps right
 *   BP2-2   affectedOrgId — GIN containment: ONLY rows whose array contains it
 *   BP2-3   actionType prefix — matches the prefix, excludes siblings
 *   BP2-4a  fromDate window
 *   BP2-4b  toDate window
 *   BP2-4c  fromDate+toDate window (both bounds)
 *   BP2-5   cursor pagination — limit=1 → has_more+cursor, next page no overlap
 *   BP2-6   the read is AUDITED — a new provider.self_audit.searched row exists
 *   BP2-7   projection safety — item shape is EXACTLY the allowlist (no metadata leak)
 *   BP2-8   affectedOrgId injection — a hostile uuid-shaped value can't widen results
 */
import { randomUUID } from 'node:crypto';

import type { ProviderSelfAuditItem } from '@emapp/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import {
  createTestOrg,
  createTestProviderUser,
  type TestProviderUser,
} from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import type { ProviderPrincipal } from './current-provider.decorator';
import { ProviderAuditService } from './provider-audit.service';

let provider: TestProviderUser;
let svc: ProviderAuditService;

// Per-run marker baked into every seeded action_type so we can pick our
// rows out of any parallel-test pollution in the shared dev DB.
const RUN = `bp2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let orgA: { id: string };
let orgB: { id: string };
let orgC: { id: string };

/** ids of the rows WE seeded, in seed order. */
const ourIds: string[] = [];
/** seeded-row metadata for ground-truth assertions, keyed by id. */
interface SeedSpec {
  id: string;
  actionType: string;
  reason: string;
  targetTable: string | null;
  targetRecordId: string | null;
  affectedOrgs: string[] | null;
  ip: string | null;
  userAgent: string | null;
  startedAt: Date;
  endedAt: Date | null;
  queryCount: number | null;
}
const seeds = new Map<string, SeedSpec>();

function principal(): ProviderPrincipal {
  return {
    sub: provider.id,
    ip: '198.51.100.7',
    userAgent: 'BP2-self-audit-spec/1.0',
  };
}

/**
 * Insert a provider_audit_log row directly via providerPool (BYPASSRLS),
 * giving us exact control of every column. Returns the new row id.
 */
async function seedRow(input: {
  actionSuffix: string; // appended after the RUN marker
  startedAt: Date;
  endedAt?: Date | null;
  affectedOrgs?: string[] | null;
  reason?: string;
  targetTable?: string | null;
  targetRecordId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  queryCount?: number | null;
}): Promise<string> {
  const actionType = `${RUN}.${input.actionSuffix}`;
  const reason = input.reason ?? `seed reason ${input.actionSuffix}`;
  const targetTable = input.targetTable === undefined ? 'organizations' : input.targetTable;
  const targetRecordId = input.targetRecordId === undefined ? randomUUID() : input.targetRecordId;
  const ip = input.ip === undefined ? '203.0.113.42' : input.ip;
  const userAgent = input.userAgent === undefined ? 'seed-agent/1.0' : input.userAgent;
  const queryCount = input.queryCount === undefined ? 3 : input.queryCount;
  const endedAt =
    input.endedAt === undefined ? new Date(input.startedAt.getTime() + 50) : input.endedAt;
  const affectedOrgs = input.affectedOrgs === undefined ? null : input.affectedOrgs;

  const client = await providerPool.connect();
  try {
    const res = await client.query<{ id: string }>(
      `INSERT INTO provider_audit_log
         (provider_user_id, reason, action_type, target_table, target_record_id,
          affected_orgs, ip, user_agent, started_at, ended_at, query_count, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       RETURNING id`,
      [
        provider.id,
        reason,
        actionType,
        targetTable,
        targetRecordId,
        affectedOrgs, // node-pg encodes string[] as a uuid[] literal
        ip,
        userAgent,
        input.startedAt.toISOString(),
        endedAt ? endedAt.toISOString() : null,
        queryCount,
        JSON.stringify({ seeded: true, secret: 'do-not-leak' }),
      ],
    );
    const id = res.rows[0]!.id;
    ourIds.push(id);
    seeds.set(id, {
      id,
      actionType,
      reason,
      targetTable,
      targetRecordId,
      affectedOrgs,
      ip,
      userAgent,
      startedAt: input.startedAt,
      endedAt,
      queryCount,
    });
    return id;
  } finally {
    client.release();
  }
}

/** Query the raw provider_audit_log for our provider (ground truth). */
async function rawRowsForProvider(): Promise<
  Array<{ id: string; action_type: string; reason: string; metadata: Record<string, unknown> }>
> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{
      id: string;
      action_type: string;
      reason: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT id, action_type, reason, metadata FROM provider_audit_log
       WHERE provider_user_id = $1 ORDER BY started_at DESC LIMIT 500`,
      [provider.id],
    );
    return r.rows;
  } finally {
    client.release();
  }
}

/** Keep only the rows WE seeded — defends against parallel-spec pollution. */
function onlyOurs(rows: ProviderSelfAuditItem[]): ProviderSelfAuditItem[] {
  const set = new Set(ourIds);
  return rows.filter((r) => set.has(r.id));
}

// Distinct, well-separated timestamps. CRITICAL: these are FAR-FUTURE so
// our 5 seeds are ALWAYS the newest rows in provider_audit_log. The reader
// writes its OWN `provider.self_audit.searched` row at real `now()` on every
// call (withProvider sets started_at = new Date()); with ORDER BY started_at
// DESC + LIMIT, those now-dated rows (accumulating across runs in the shared
// dev DB) would crowd our seeds out of the first page if our seeds were in
// the past. Far-future timestamps keep our seeds on top + immune to the
// reader's self-audit pollution. (The product is correct; this is purely a
// test-isolation choice against a shared, polluted DB.)
const T = {
  // oldest → newest
  s1: new Date('2099-01-10T08:00:00.000Z'),
  s2: new Date('2099-02-10T08:00:00.000Z'),
  s3: new Date('2099-03-10T08:00:00.000Z'),
  s4: new Date('2099-04-10T08:00:00.000Z'),
  s5: new Date('2099-05-10T08:00:00.000Z'),
};

beforeAll(async () => {
  await setupTestDatabase();
  provider = await createTestProviderUser();
  svc = new ProviderAuditService();

  orgA = await createTestOrg(`${RUN}-A`, `${RUN}-a`);
  orgB = await createTestOrg(`${RUN}-B`, `${RUN}-b`);
  orgC = await createTestOrg(`${RUN}-C`, `${RUN}-c`);

  // 5 seed rows with distinct action_type, started_at, affected_orgs.
  //  s1  tenant.viewed         touches orgA
  //  s2  tenant.suspended      touches orgB
  //  s3  tenant.reactivated    touches orgA + orgC (multi-org array)
  //  s4  audit.searched        touches nothing (affected_orgs = null)
  //  s5  tenant.onboarded      touches orgC
  await seedRow({ actionSuffix: 'tenant.viewed', startedAt: T.s1, affectedOrgs: [orgA.id] });
  await seedRow({ actionSuffix: 'tenant.suspended', startedAt: T.s2, affectedOrgs: [orgB.id] });
  await seedRow({
    actionSuffix: 'tenant.reactivated',
    startedAt: T.s3,
    affectedOrgs: [orgA.id, orgC.id],
  });
  await seedRow({
    actionSuffix: 'audit.searched',
    startedAt: T.s4,
    affectedOrgs: null,
    targetTable: 'audit_log',
    targetRecordId: null,
    ip: null,
    userAgent: null,
    endedAt: null,
    queryCount: null,
  });
  await seedRow({ actionSuffix: 'tenant.onboarded', startedAt: T.s5, affectedOrgs: [orgC.id] });
}, 60_000);

afterAll(() => {
  // providerPool is a shared singleton — nothing to tear down.
});

describe('GET /provider/audit/self — B-PROVIDER-2 self-audit reader', () => {
  it('BP2-1a) no filters → our seeded rows returned, ordered started_at DESC', async () => {
    const res = await svc.selfSearch(principal(), 'TKT-2001: BP2 no-filter read', { limit: 100 });
    const ours = onlyOurs(res.data);
    // All 5 seeds present.
    const ids = new Set(ours.map((r) => r.id));
    for (const id of ourIds) expect(ids.has(id)).toBe(true);
    // Strictly non-increasing started_at across the full (unfiltered) set —
    // proves the ORDER BY started_at DESC over the whole result, not just ours.
    for (let i = 1; i < res.data.length; i += 1) {
      expect(res.data[i - 1]!.startedAt.getTime()).toBeGreaterThanOrEqual(
        res.data[i]!.startedAt.getTime(),
      );
    }
    // And within OUR rows: newest seed (s5) must come before oldest (s1).
    const oursOrdered = ours.map((r) => r.startedAt.getTime());
    const sortedDesc = [...oursOrdered].sort((a, b) => b - a);
    expect(oursOrdered).toEqual(sortedDesc);
  });

  it('BP2-1b) field projection — every ProviderSelfAuditItem field maps to the seeded column', async () => {
    const res = await svc.selfSearch(principal(), 'TKT-2002: BP2 field-map read', { limit: 100 });
    for (const item of onlyOurs(res.data)) {
      const seed = seeds.get(item.id)!;
      expect(item.providerUserId).toBe(provider.id);
      expect(item.reason).toBe(seed.reason);
      expect(item.actionType).toBe(seed.actionType);
      expect(item.targetTable).toBe(seed.targetTable);
      expect(item.targetRecordId).toBe(seed.targetRecordId);
      expect(item.affectedOrgs).toEqual(seed.affectedOrgs);
      // inet round-trips as the plain address string.
      expect(item.ip).toBe(seed.ip);
      expect(item.userAgent).toBe(seed.userAgent);
      expect(item.startedAt.getTime()).toBe(seed.startedAt.getTime());
      if (seed.endedAt === null) expect(item.endedAt).toBeNull();
      else expect(item.endedAt!.getTime()).toBe(seed.endedAt.getTime());
      expect(item.queryCount).toBe(seed.queryCount);
    }
  });

  it('BP2-2) affectedOrgId — GIN containment returns ONLY rows whose array contains the org', async () => {
    // orgA is touched by s1 (sole) and s3 (multi-org). orgB by s2 only.
    const resA = await svc.selfSearch(principal(), 'TKT-2003: BP2 affectedOrg A', {
      limit: 100,
      affectedOrgId: orgA.id,
    });
    const oursA = onlyOurs(resA.data);
    const idsA = new Set(oursA.map((r) => r.id));
    // s1 and s3 included; s2/s4/s5 excluded.
    expect(idsA.has(ourIds[0]!)).toBe(true); // s1
    expect(idsA.has(ourIds[2]!)).toBe(true); // s3 (multi-org)
    expect(idsA.has(ourIds[1]!)).toBe(false); // s2 (orgB)
    expect(idsA.has(ourIds[3]!)).toBe(false); // s4 (null array)
    expect(idsA.has(ourIds[4]!)).toBe(false); // s5 (orgC)
    // Every returned row's array actually contains orgA — no false positives.
    for (const r of oursA) expect(r.affectedOrgs).toContain(orgA.id);

    // orgB → only s2.
    const resB = await svc.selfSearch(principal(), 'TKT-2004: BP2 affectedOrg B', {
      limit: 100,
      affectedOrgId: orgB.id,
    });
    const idsB = new Set(onlyOurs(resB.data).map((r) => r.id));
    expect(idsB.has(ourIds[1]!)).toBe(true);
    expect(idsB.has(ourIds[0]!)).toBe(false);
    expect(idsB.has(ourIds[2]!)).toBe(false);
  });

  it('BP2-3) actionType prefix — matches the prefix, excludes siblings', async () => {
    // 'RUN.tenant.' should match the four tenant.* seeds but NOT
    // 'RUN.audit.searched' (s4).
    const res = await svc.selfSearch(principal(), 'TKT-2005: BP2 actionType prefix', {
      limit: 100,
      actionType: `${RUN}.tenant.`,
    });
    const ours = onlyOurs(res.data);
    const ids = new Set(ours.map((r) => r.id));
    expect(ids.has(ourIds[0]!)).toBe(true); // tenant.viewed
    expect(ids.has(ourIds[1]!)).toBe(true); // tenant.suspended
    expect(ids.has(ourIds[2]!)).toBe(true); // tenant.reactivated
    expect(ids.has(ourIds[4]!)).toBe(true); // tenant.onboarded
    expect(ids.has(ourIds[3]!)).toBe(false); // audit.searched — excluded
    for (const r of ours) expect(r.actionType.startsWith(`${RUN}.tenant.`)).toBe(true);

    // A more specific prefix: only the exact 'tenant.suspended'.
    const res2 = await svc.selfSearch(principal(), 'TKT-2006: BP2 actionType exact prefix', {
      limit: 100,
      actionType: `${RUN}.tenant.suspended`,
    });
    const ids2 = new Set(onlyOurs(res2.data).map((r) => r.id));
    expect(ids2.has(ourIds[1]!)).toBe(true);
    expect(ids2.has(ourIds[0]!)).toBe(false);
  });

  it('BP2-4a) fromDate window — inclusive lower bound on started_at', async () => {
    // Floor between s2 (Feb) and s3 (Mar): expect s3,s4,s5 only.
    const floor = new Date('2099-02-20T00:00:00.000Z');
    const res = await svc.selfSearch(principal(), 'TKT-2007: BP2 fromDate window', {
      limit: 100,
      fromDate: floor,
    });
    const ids = new Set(onlyOurs(res.data).map((r) => r.id));
    expect(ids.has(ourIds[0]!)).toBe(false); // s1 Jan
    expect(ids.has(ourIds[1]!)).toBe(false); // s2 Feb
    expect(ids.has(ourIds[2]!)).toBe(true); // s3 Mar
    expect(ids.has(ourIds[3]!)).toBe(true); // s4 Apr
    expect(ids.has(ourIds[4]!)).toBe(true); // s5 May
    for (const r of onlyOurs(res.data))
      expect(r.startedAt.getTime()).toBeGreaterThanOrEqual(floor.getTime());
  });

  it('BP2-4b) toDate window — inclusive upper bound on started_at', async () => {
    // Ceiling between s3 (Mar) and s4 (Apr): expect s1,s2,s3 only.
    const ceil = new Date('2099-03-20T00:00:00.000Z');
    const res = await svc.selfSearch(principal(), 'TKT-2008: BP2 toDate window', {
      limit: 100,
      toDate: ceil,
    });
    const ids = new Set(onlyOurs(res.data).map((r) => r.id));
    expect(ids.has(ourIds[0]!)).toBe(true); // s1
    expect(ids.has(ourIds[1]!)).toBe(true); // s2
    expect(ids.has(ourIds[2]!)).toBe(true); // s3
    expect(ids.has(ourIds[3]!)).toBe(false); // s4
    expect(ids.has(ourIds[4]!)).toBe(false); // s5
    for (const r of onlyOurs(res.data))
      expect(r.startedAt.getTime()).toBeLessThanOrEqual(ceil.getTime());
  });

  it('BP2-4c) fromDate+toDate window — both bounds (only s2,s3,s4)', async () => {
    const floor = new Date('2099-01-20T00:00:00.000Z'); // after s1
    const ceil = new Date('2099-04-20T00:00:00.000Z'); // after s4, before s5
    const res = await svc.selfSearch(principal(), 'TKT-2009: BP2 from and to window', {
      limit: 100,
      fromDate: floor,
      toDate: ceil,
    });
    const ids = new Set(onlyOurs(res.data).map((r) => r.id));
    expect(ids.has(ourIds[0]!)).toBe(false); // s1 before floor
    expect(ids.has(ourIds[1]!)).toBe(true); // s2
    expect(ids.has(ourIds[2]!)).toBe(true); // s3
    expect(ids.has(ourIds[3]!)).toBe(true); // s4
    expect(ids.has(ourIds[4]!)).toBe(false); // s5 after ceil
  });

  it('BP2-5) cursor pagination — limit=1 paginates our seeds with no overlap, correct order', async () => {
    // Bound the walk to OUR rows via the tenant. action prefix is not
    // enough (audit.searched is also ours), so use a date window that
    // brackets all 5 seeds and the RUN marker can't be applied to
    // started_at — instead we just walk and collect only ours.
    const seen: string[] = [];
    const seenSet = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    // Restrict the scan window to our (far-future) seed timeframe so the
    // page is composed ONLY of our 5 rows. The reader's own
    // `provider.self_audit.searched` rows land at real `now()` (2026),
    // BELOW this 2099 floor — so they can never enter the walk and the
    // "no overlap + exactly our 5" assertions are exact.
    const floor = new Date('2099-01-01T00:00:00.000Z');
    const ceil = new Date('2099-05-31T00:00:00.000Z');
    while (pages < 50) {
      const page = await svc.selfSearch(principal(), `TKT-2010: BP2 cursor walk page ${pages}`, {
        limit: 1,
        cursor,
        fromDate: floor,
        toDate: ceil,
      });
      expect(page.data.length).toBeLessThanOrEqual(1);
      for (const r of page.data) {
        // No overlap across pages.
        expect(seenSet.has(r.id)).toBe(false);
        seenSet.add(r.id);
        seen.push(r.id);
      }
      if (!page.page.has_more) break;
      expect(page.page.cursor).toBeTruthy();
      cursor = page.page.cursor ?? undefined;
      pages += 1;
    }
    // Every seeded row seen exactly once.
    for (const id of ourIds) expect(seenSet.has(id)).toBe(true);
    // The ids we saw, restricted to ours, are in started_at DESC order.
    const oursSeen = seen.filter((id) => seeds.has(id));
    const expectedDesc = [...ourIds].sort(
      (a, b) => seeds.get(b)!.startedAt.getTime() - seeds.get(a)!.startedAt.getTime(),
    );
    expect(oursSeen).toEqual(expectedDesc);
  });

  it('BP2-6) the read is AUDITED — a new provider.self_audit.searched row is appended', async () => {
    // Ticket-prefixed so it passes withProvider's reason quality gate AND
    // is stored verbatim (validator only trims — no internal mutation), so
    // `metadata.reason === MARKER` holds exactly.
    const MARKER = `TKT-9999-${randomUUID()}`;
    const before = await rawRowsForProvider();
    const beforeMatch = before.filter((r) => (r.metadata as { reason?: string }).reason === MARKER);
    expect(beforeMatch.length).toBe(0);

    await svc.selfSearch(principal(), MARKER, { limit: 10 });

    const after = await rawRowsForProvider();
    const newRow = after.find((r) => (r.metadata as { reason?: string }).reason === MARKER);
    expect(newRow).toBeDefined();
    expect(newRow!.action_type).toBe('provider.self_audit.searched');
    // The forensic reason is recorded both in the column and metadata.reason.
    expect(newRow!.reason).toBe(MARKER);
    const md = newRow!.metadata as {
      endpoint?: string;
      filter?: { limit?: number };
    };
    expect(md.endpoint).toBe('self-audit');
    expect(md.filter?.limit).toBe(10);
  });

  it('BP2-7) projection safety — item shape is EXACTLY the allowlist (no metadata / extra columns leak)', async () => {
    const res = await svc.selfSearch(principal(), 'TKT-2011: BP2 projection shape', { limit: 100 });
    const ours = onlyOurs(res.data);
    expect(ours.length).toBeGreaterThan(0);
    const ALLOWED = [
      'id',
      'providerUserId',
      'reason',
      'actionType',
      'targetTable',
      'targetRecordId',
      'affectedOrgs',
      'ip',
      'userAgent',
      'startedAt',
      'endedAt',
      'queryCount',
    ].sort();
    for (const item of ours) {
      expect(Object.keys(item).sort()).toEqual(ALLOWED);
    }
    // The seeded metadata held a 'secret' — confirm it never reaches the wire.
    const blob = JSON.stringify(res.data);
    expect(blob).not.toContain('do-not-leak');
    expect(blob).not.toContain('metadata');
  });

  it('BP2-8) affectedOrgId is a parameterised uuid[] containment — no injection / no widening', async () => {
    // A random uuid that no seed references must return ZERO of our rows.
    // (Proves the @> ARRAY[...] is a real containment, not a tautology, and
    // that the value is bound as a parameter — a crafted value can't widen.)
    const phantom = randomUUID();
    const res = await svc.selfSearch(principal(), 'TKT-2012: BP2 phantom org', {
      limit: 100,
      affectedOrgId: phantom,
    });
    const ours = onlyOurs(res.data);
    expect(ours.length).toBe(0);
  });
});
