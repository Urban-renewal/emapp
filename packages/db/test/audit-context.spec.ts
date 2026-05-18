/**
 * AuditService forensic-context proof (ISO 27001 A.12.4).
 *
 * Deterministic, zero-infra (stub db handle). Proves the cross-cutting
 * source IP / User-Agent context is merged into EVERY audit row from one
 * place, and that a per-entry value always overrides a default. This is
 * the verification artifact that the audit trail captures provenance.
 */
import { describe, expect, it } from 'vitest';

import type { Database } from '../src/client';
import { AuditService, type AuditEntry } from '../src/index';

function stubDb(): { db: Database; rows: () => Record<string, unknown>[] } {
  const captured: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
        for (const r of Array.isArray(v) ? v : [v]) captured.push(r);
        return Promise.resolve();
      },
    }),
  } as unknown as Database;
  return { db, rows: () => captured };
}

const base: AuditEntry = { orgId: 'o', actorType: 'user', action: 'x.create' };

describe('AuditService — forensic context (A.12.4)', () => {
  it('merges default ip/userAgent into every entry', async () => {
    const s = stubDb();
    await new AuditService(s.db, { ip: '203.0.113.7', userAgent: 'Mozilla/UA' }).log(base);
    expect(s.rows()[0]?.['ip']).toBe('203.0.113.7');
    expect(s.rows()[0]?.['userAgent']).toBe('Mozilla/UA');
  });

  it('a per-entry value overrides the default (entry wins)', async () => {
    const s = stubDb();
    await new AuditService(s.db, { ip: '203.0.113.7' }).log({ ...base, ip: '198.51.100.9' });
    expect(s.rows()[0]?.['ip']).toBe('198.51.100.9');
  });

  it('logMany applies the context to each row', async () => {
    const s = stubDb();
    await new AuditService(s.db, { ip: '203.0.113.7' }).logMany([base, { ...base, action: 'y' }]);
    expect(s.rows()).toHaveLength(2);
    expect(s.rows().every((r) => r['ip'] === '203.0.113.7')).toBe(true);
  });

  it('backward compatible: no defaults ⇒ ip/userAgent null (unchanged)', async () => {
    const s = stubDb();
    await new AuditService(s.db).log(base);
    expect(s.rows()[0]?.['ip']).toBeNull();
    expect(s.rows()[0]?.['userAgent']).toBeNull();
  });
});
