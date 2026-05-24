/**
 * D.37 / Phase 6.5 — withProvider audit-row contract tests.
 *
 * D.37 mandates that every `withProvider` call writes a
 * `provider_audit_log` row whose:
 *   - `reason` column matches the caller-supplied reason
 *   - `metadata.reason` ALSO matches the reason (foundational
 *     invariant — T6.5-D37-0; pre-Phase-6.5 metadata was always
 *     `{}` which broke every standard audit-search pattern that
 *     pivots through metadata)
 *   - `action_type` defaults to `'session'` (back-compat) and can
 *     be overridden by passing `context.action`
 *   - Caller-supplied `context.metadata` is merged BENEATH the
 *     `reason` overlay — a hostile caller cannot smuggle a fake
 *     `reason` into metadata
 *
 * These tests pin the foundational invariant Phase 6.5 endpoints
 * (and any future Provider-tier endpoint) rely on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../src/client';
import { withProvider } from '../src/wrappers/with-provider';

import { createTestProviderUser, type TestProviderUser } from './factories';
import { setupTestDatabase } from './setup';

interface AuditRow {
  reason: string;
  action_type: string;
  metadata: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
  target_table: string | null;
  target_record_id: string | null;
}

async function latestAuditRowFor(providerUserId: string): Promise<AuditRow | null> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<AuditRow>(
      `SELECT reason, action_type, metadata, ip, user_agent, target_table, target_record_id
       FROM provider_audit_log
       WHERE provider_user_id = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [providerUserId],
    );
    return r.rows[0] ?? null;
  } finally {
    client.release();
  }
}

describe('D.37 withProvider — audit row contract', () => {
  let provider: TestProviderUser;

  beforeAll(async () => {
    await setupTestDatabase();
    provider = await createTestProviderUser();
  });

  afterAll(() => {
    // Pools are shared module-singletons — global teardown handles them.
  });

  it('T6.5-D37-0a) reason is populated in BOTH the column AND metadata.reason', async () => {
    const REASON = 'support ticket #42 — investigating tenant 90 day-1 retention regression';
    await withProvider(provider.id, REASON, async () => undefined);
    const row = await latestAuditRowFor(provider.id);
    expect(row).toBeDefined();
    expect(row!.reason).toBe(REASON);
    // The foundational invariant the test ID exists for:
    expect(row!.metadata).toBeDefined();
    expect((row!.metadata as { reason?: string }).reason).toBe(REASON);
  });

  it('T6.5-D37-0b) action_type defaults to "session" when no action provided (back-compat)', async () => {
    await withProvider(provider.id, 'back-compat default test', async () => undefined);
    const row = await latestAuditRowFor(provider.id);
    expect(row!.action_type).toBe('session');
  });

  it('T6.5-D37-0c) action_type respects caller override (Phase 6.5 needs this)', async () => {
    await withProvider(provider.id, 'tenant viewed', async () => undefined, {
      action: 'provider.tenant.viewed',
    });
    const row = await latestAuditRowFor(provider.id);
    expect(row!.action_type).toBe('provider.tenant.viewed');
  });

  it('T6.5-D37-0d) caller-supplied metadata is merged BENEATH the reason overlay', async () => {
    const REASON = 'merge precedence test';
    await withProvider(provider.id, REASON, async () => undefined, {
      metadata: { filter: { org_id: 'abc' }, requestId: 'req-123' },
    });
    const row = await latestAuditRowFor(provider.id);
    const md = row!.metadata as { reason?: string; filter?: unknown; requestId?: string };
    expect(md.reason).toBe(REASON);
    expect(md.filter).toEqual({ org_id: 'abc' });
    expect(md.requestId).toBe('req-123');
  });

  it('T6.5-D37-0e) caller CANNOT smuggle a fake reason in metadata — overlay wins', async () => {
    // Adversarial: a hostile/buggy caller passes metadata.reason that
    // contradicts the real reason. The wrapper MUST overlay so
    // metadata.reason always equals the recorded reason column.
    const TRUTH = 'real reason — investigating tenant X';
    const SMUGGLE = 'fake reason — investigating tenant Y';
    await withProvider(provider.id, TRUTH, async () => undefined, {
      metadata: { reason: SMUGGLE },
    });
    const row = await latestAuditRowFor(provider.id);
    expect(row!.reason).toBe(TRUTH);
    expect((row!.metadata as { reason?: string }).reason).toBe(TRUTH);
    expect((row!.metadata as { reason?: string }).reason).not.toBe(SMUGGLE);
  });

  it('T6.5-D37-0f) ip / userAgent / targetTable / targetRecordId all pass through unchanged', async () => {
    await withProvider(provider.id, 'context fields passthrough', async () => undefined, {
      ip: '203.0.113.5',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Provider-Admin/1.0',
      targetTable: 'organizations',
      targetRecordId: '00000000-0000-4000-8000-00000000abcd',
      action: 'provider.tenant.viewed',
    });
    const row = await latestAuditRowFor(provider.id);
    expect(row!.ip).toBe('203.0.113.5');
    expect(row!.user_agent).toContain('Provider-Admin/1.0');
    expect(row!.target_table).toBe('organizations');
    expect(row!.target_record_id).toBe('00000000-0000-4000-8000-00000000abcd');
    expect(row!.action_type).toBe('provider.tenant.viewed');
  });

  it('T6.5-D37-0g) rollback on fn() throw — NO audit row left behind (tx integrity)', async () => {
    // The wrapper runs INSERT inside the BEGIN/COMMIT. If fn() throws,
    // ROLLBACK must take the audit row with it. This pins that the
    // pre-D.37 contract (tx-bound audit) still holds AFTER the
    // metadata change.
    const REASON = 'rollback-test-' + Date.now();
    await expect(
      withProvider(provider.id, REASON, async () => {
        throw new Error('synthetic failure');
      }),
    ).rejects.toThrow(/synthetic failure/);

    // Search the audit log for our distinctive reason — must be 0 rows.
    const client = await providerPool.connect();
    try {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM provider_audit_log WHERE reason = $1`,
        [REASON],
      );
      expect(Number(r.rows[0]!.count)).toBe(0);
    } finally {
      client.release();
    }
  });
});
