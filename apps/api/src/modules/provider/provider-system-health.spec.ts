/**
 * D.37 / Phase 6.5 — `GET /provider/system-health` integration spec.
 *
 * Test IDs (D.33):
 *   T6.5-D37-9a   response shape — { queue, pool, r2, timestamp }
 *   T6.5-D37-9b   queue gauges are all non-negative integers
 *   T6.5-D37-9c   pool gauges expose ONLY {total, idle, waiting}
 *                 (no leaked internals)
 *   T6.5-D37-9d   r2 counter starts at 0 after reset + increments
 *                 when recordStorageError fires
 *   T6.5-D37-9e   r2 lastErrorAt is populated when counter increments
 *   T6.5-D37-9f   wire shape contains ZERO non-numeric, non-Date,
 *                 non-null values — i.e. no string PII surface possible
 *  T6.5-D37-10a  every call writes audit row with
 *                 action='provider.health.read' + metadata.endpoint
 *  T6.5-D37-10b  call works under concurrent invocation (no shared
 *                 mutable state in service)
 */
import { recordStorageError, resetStorageErrorStatsForTests } from '@emapp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import {
  createTestProviderUser,
  type TestProviderUser,
} from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import type { ProviderPrincipal } from './current-provider.decorator';
import {
  ProviderSystemHealthService,
  resetSystemHealthCacheForTests,
} from './provider-system-health.service';

let provider: TestProviderUser;
let svc: ProviderSystemHealthService;
let auditStartMarker: Date;

function principal(): ProviderPrincipal {
  // Audit v1.1 CC-4 — narrow actor shape; role / sid / type are not
  // service inputs.
  return {
    sub: provider.id,
    ip: '203.0.113.77',
    userAgent: 'P6.5-5-spec/1.0',
  };
}

beforeAll(async () => {
  await setupTestDatabase();
  provider = await createTestProviderUser();
  svc = new ProviderSystemHealthService();
  auditStartMarker = new Date();
}, 60_000);

beforeEach(() => {
  // Test seam — reset the storage-error counter so each test starts
  // from a known baseline. Production code never calls this.
  resetStorageErrorStatsForTests();
  // Audit v1.1 CC-5 — also reset the 30-s in-process system-health
  // cache. Otherwise tests that mutate the r2 counter between two
  // svc.read() calls would see the cached pre-mutation value.
  resetSystemHealthCacheForTests();
});

afterAll(() => {
  // Pools are shared singletons; teardown is global.
});

async function ourAuditRows(): Promise<
  Array<{ action_type: string; metadata: Record<string, unknown> }>
> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{ action_type: string; metadata: Record<string, unknown> }>(
      `SELECT action_type, metadata FROM provider_audit_log
       WHERE provider_user_id = $1 AND started_at >= $2
       ORDER BY started_at DESC`,
      [provider.id, auditStartMarker.toISOString()],
    );
    return r.rows;
  } finally {
    client.release();
  }
}

describe('GET /provider/system-health — P6.5-5 service integration', () => {
  it('T6.5-D37-9a) response shape — top-level keys are exactly {queue, pool, r2, timestamp}', async () => {
    const health = await svc.read(principal(), 'TKT-1100: shape sanity');
    const topKeys = Object.keys(health).sort();
    expect(topKeys).toEqual(['pool', 'queue', 'r2', 'timestamp']);
    expect(health.timestamp).toBeInstanceOf(Date);
  });

  it('T6.5-D37-9b) queue gauges all non-negative integers', async () => {
    const { queue } = await svc.read(principal(), 'TKT-1100: queue shape');
    expect(Number.isInteger(queue.created)).toBe(true);
    expect(queue.created).toBeGreaterThanOrEqual(0);
    expect(queue.active).toBeGreaterThanOrEqual(0);
    expect(queue.retry).toBeGreaterThanOrEqual(0);
    expect(queue.failed).toBeGreaterThanOrEqual(0);
    expect(queue.completed).toBeGreaterThanOrEqual(0);
  });

  it('T6.5-D37-9c) pool gauges shape — both pools, ONLY {total, idle, waiting}', async () => {
    const { pool } = await svc.read(principal(), 'TKT-1100: pool shape');
    expect(Object.keys(pool).sort()).toEqual(['app', 'provider']);
    for (const name of ['app', 'provider'] as const) {
      const p = pool[name];
      expect(Object.keys(p).sort()).toEqual(['idle', 'total', 'waiting']);
      expect(Number.isInteger(p.total)).toBe(true);
      expect(p.total).toBeGreaterThanOrEqual(0);
      expect(p.idle).toBeGreaterThanOrEqual(0);
      expect(p.waiting).toBeGreaterThanOrEqual(0);
    }
  });

  it('T6.5-D37-9d) r2 counter starts at 0 after reset; recordStorageError increments', async () => {
    const before = await svc.read(principal(), 'TKT-1100: r2 counter before');
    expect(before.r2.errorsSinceBoot).toBe(0);
    expect(before.r2.lastErrorAt).toBeNull();

    recordStorageError({ op: 'put', errorClass: 'NetworkError' });
    recordStorageError({ op: 'get', errorClass: 'TimeoutError' });
    recordStorageError({ op: 'delete', errorClass: 'NoSuchBucket' });

    // Audit v1.1 CC-5 — bust the 30-s cache so the next read fetches
    // fresh stats. In production the cache absorbs polls within a 30-s
    // window; here we explicitly want the post-recordStorageError
    // snapshot, not the pre-mutation cached one.
    resetSystemHealthCacheForTests();

    const after = await svc.read(principal(), 'TKT-1100: r2 counter after');
    expect(after.r2.errorsSinceBoot).toBe(3);
    expect(after.r2.lastErrorAt).toBeInstanceOf(Date);
  });

  it('T6.5-D37-9e) r2 lastErrorAt is populated on first error and advances on subsequent errors', async () => {
    recordStorageError({ op: 'put', errorClass: 'X' });
    resetSystemHealthCacheForTests();
    const a = await svc.read(principal(), 'TKT-1100: lastErrorAt a');
    const firstTimestamp = a.r2.lastErrorAt;
    expect(firstTimestamp).toBeInstanceOf(Date);
    // Wait a tick to guarantee the next Date.now() is different (Windows
    // can have ~16ms resolution; 25ms is safe).
    await new Promise((r) => setTimeout(r, 25));
    recordStorageError({ op: 'put', errorClass: 'X' });
    resetSystemHealthCacheForTests();
    const b = await svc.read(principal(), 'TKT-1100: lastErrorAt b');
    expect(b.r2.lastErrorAt!.getTime()).toBeGreaterThan(firstTimestamp!.getTime());
  });

  it('T6.5-D37-9f) wire-shape leaf values are ONLY numbers / Date / null (no string PII surface)', async () => {
    const health = await svc.read(principal(), 'TKT-1100: leaf-type scan');
    function assertLeaves(obj: unknown, path = '$'): void {
      if (obj === null) return;
      if (typeof obj === 'number') return;
      if (obj instanceof Date) return;
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i += 1) assertLeaves(obj[i], `${path}[${i}]`);
        return;
      }
      if (typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) assertLeaves(v, `${path}.${k}`);
        return;
      }
      // typeof string, boolean, etc. → fail loud
      throw new Error(
        `Leaf at ${path} is ${typeof obj} (${JSON.stringify(obj)}) — wire shape must be number | Date | null only`,
      );
    }
    assertLeaves(health);
  });

  it('T6.5-D37-10a) every call writes audit row: action=provider.health.read + metadata.endpoint=system-health', async () => {
    const REASON = 'audit content for health check ' + Date.now();
    await svc.read(principal(), REASON);
    const rows = await ourAuditRows();
    const ours = rows.find((r) => (r.metadata as { reason?: string }).reason === REASON);
    expect(ours).toBeDefined();
    expect(ours!.action_type).toBe('provider.health.read');
    const md = ours!.metadata as { endpoint?: string; reason?: string };
    expect(md.endpoint).toBe('system-health');
    expect(md.reason).toBe(REASON);
  });

  it('T6.5-D37-10b) 5 concurrent calls all succeed → 5 distinct audit rows; no shared state corruption', async () => {
    // Audit v1.1 CC-2 — reasons must pass the quality bar. Use a
    // ticket prefix so the validator accepts even short markers.
    const markers = Array.from(
      { length: 5 },
      (_, i) => `TKT-1100: concurrent-health-${Date.now()}-${i}`,
    );
    const results = await Promise.all(markers.map((m) => svc.read(principal(), m)));
    // All 5 succeed.
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.timestamp).toBeInstanceOf(Date);
      expect(r.queue).toBeDefined();
      expect(r.pool).toBeDefined();
      expect(r.r2).toBeDefined();
    }
    // 5 distinct audit rows.
    const auditRows = await ourAuditRows();
    const distinct = new Set(
      auditRows
        .map((r) => (r.metadata as { reason?: string }).reason)
        .filter((x): x is string => typeof x === 'string'),
    );
    for (const m of markers) expect(distinct.has(m)).toBe(true);
  });
});
