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
    await withProvider(provider.id, 'TKT-1100: back-compat default test', async () => undefined);
    const row = await latestAuditRowFor(provider.id);
    expect(row!.action_type).toBe('session');
  });

  it('T6.5-D37-0c) action_type respects caller override (Phase 6.5 needs this)', async () => {
    await withProvider(provider.id, 'TKT-1100: tenant viewed', async () => undefined, {
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
    await withProvider(provider.id, 'TKT-1100: context fields passthrough', async () => undefined, {
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

  it('T6.5-D37-0g) Audit v1.1 SA-7 — fn() throw leaves audit row PERSISTED (autonomous tx)', async () => {
    // **Contract change post-Audit v1.1 SA-7 (ISO A.12.4.3):** the
    // audit INSERT now runs in an AUTONOMOUS transaction on a separate
    // pool connection, committed BEFORE the work tx starts. A crafted-
    // failure input that makes fn() throw can NO LONGER suppress the
    // audit row. This was a fresh-eyes finding from the v1.1 audit —
    // pre-closure the same-tx coupling allowed pre-commit audit
    // suppression, which an ISO 27001 A.12.4.3 review would flag.
    //
    // This test inverts the pre-SA-7 assertion: count MUST be 1.
    const REASON = `TKT-1100: rollback-test-${Date.now()}`;
    await expect(
      withProvider(provider.id, REASON, async () => {
        throw new Error('synthetic failure');
      }),
    ).rejects.toThrow(/synthetic failure/);

    // Audit row MUST persist — SA-7 invariant.
    const client = await providerPool.connect();
    try {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM provider_audit_log WHERE reason = $1`,
        [REASON],
      );
      expect(Number(r.rows[0]!.count)).toBe(1);
    } finally {
      client.release();
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // Adversarial battery (P6.5-1 hardening): pin every input-validation
  // path. Without these, the wrapper would silently accept attacker-
  // controlled bytes into audit_log / GUC / row size.
  // ───────────────────────────────────────────────────────────────────

  it('T6.5-D37-0h) action with control chars rejected (provider_action_invalid)', async () => {
    await expect(
      withProvider(provider.id, 'TKT-1100: valid reason for action test', async () => undefined, {
        // \n is a control char + not in the allowed regex class
        action: 'provider.tenant.viewed\n',
      }),
    ).rejects.toThrow(/provider_action_invalid/);
  });

  it('T6.5-D37-0h2) action with SQL-shape rejected — parameter binding makes injection impossible, but regex catches POLLUTION', async () => {
    await expect(
      withProvider(
        provider.id,
        'TKT-1100: valid reason for SQL-shape action',
        async () => undefined,
        {
          action: "'); DROP TABLE provider_audit_log; --",
        },
      ),
    ).rejects.toThrow(/provider_action_invalid/);
    // owners table still intact (defense-in-depth — parameter binding
    // would have stopped SQL anyway).
    const client = await providerPool.connect();
    try {
      await client.query('SELECT 1 FROM provider_audit_log LIMIT 1');
    } finally {
      client.release();
    }
  });

  it('T6.5-D37-0h3) action exceeding 128 chars rejected', async () => {
    const tooLong = 'a.'.repeat(70); // 140 chars, all valid regex chars
    await expect(
      withProvider(
        provider.id,
        'TKT-1100: valid reason for long action test',
        async () => undefined,
        {
          action: tooLong,
        },
      ),
    ).rejects.toThrow(/exceeds maximum 128/);
  });

  it('T6.5-D37-0h4) action empty string rejected (action=undefined is OK; "" is not)', async () => {
    await expect(
      withProvider(provider.id, 'TKT-1100: valid reason for empty action', async () => undefined, {
        action: '',
      }),
    ).rejects.toThrow(/non-empty string/);
  });

  it('T6.5-D37-0i) reason with CRLF stripped — stored value is clean', async () => {
    // CRLF injection attempt — without stripping, audit log greppers
    // would split this into two log lines.
    const dirty = 'investigating ticket\r\nX-Injected: pwned';
    await withProvider(provider.id, dirty, async () => undefined);
    const row = await latestAuditRowFor(provider.id);
    expect(row!.reason).not.toMatch(/[\r\n]/);
    expect(row!.reason).toBe('investigating ticketX-Injected: pwned');
    // metadata.reason must match exactly the stripped column value.
    expect((row!.metadata as { reason?: string }).reason).toBe(row!.reason);
  });

  it('T6.5-D37-0i2) reason that is ALL control chars rejected (Audit v1.1 CC-2: reason_required)', async () => {
    // Pre-strip looks like 10 chars; post-strip looks like 0 chars.
    // The hardened check strips FIRST, then min-length-checks. Post
    // Audit v1.1 CC-2 the stable code is `reason_required`.
    await expect(
      withProvider(provider.id, '\r\n\r\n\r\n\r\n\r\n', async () => undefined),
    ).rejects.toThrow(/reason_required/);
  });

  it('T6.5-D37-0i3) reason > 512 chars rejected (Audit v1.1 CC-2: reason_too_long)', async () => {
    const tooLong = 'a'.repeat(513);
    await expect(withProvider(provider.id, tooLong, async () => undefined)).rejects.toThrow(
      /reason_too_long/,
    );
  });

  it('T6.5-D37-0j) metadata > 8 KB rejected (provider_metadata_too_large)', async () => {
    // Build a payload that comfortably exceeds 8 KB after stringify.
    const big = { blob: 'A'.repeat(10 * 1024) };
    await expect(
      withProvider(provider.id, 'TKT-1100: metadata size cap test', async () => undefined, {
        metadata: big,
      }),
    ).rejects.toThrow(/provider_metadata_too_large/);
  });

  it('T6.5-D37-0j2) metadata exactly at the 8 KB limit accepted (boundary test)', async () => {
    // Build a payload that lands close to but UNDER 8 KB after the
    // reason overlay + JSON encoding overhead.
    const padding = 'B'.repeat(7 * 1024);
    await expect(
      withProvider(provider.id, 'TKT-1100: metadata boundary test', async () => undefined, {
        metadata: { padding },
      }),
    ).resolves.toBeUndefined();
    const row = await latestAuditRowFor(provider.id);
    expect((row!.metadata as { padding?: string }).padding).toBe(padding);
  });

  it('T6.5-D37-0k) circular ref in metadata → provider_metadata_invalid (caught, not unhandled)', async () => {
    interface Circular {
      self?: unknown;
    }
    const cyclic: Circular = {};
    cyclic.self = cyclic;
    await expect(
      withProvider(provider.id, 'TKT-1100: circular ref test', async () => undefined, {
        metadata: cyclic as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(/provider_metadata_invalid/);
  });

  it('T6.5-D37-0k2) BigInt in metadata → provider_metadata_invalid (JSON.stringify throws on bigint)', async () => {
    await expect(
      withProvider(provider.id, 'TKT-1100: bigint metadata test', async () => undefined, {
        metadata: { count: BigInt(123) as unknown as number },
      }),
    ).rejects.toThrow(/provider_metadata_invalid/);
  });

  it('T6.5-D37-0l) 5 concurrent withProvider calls all succeed with 5 distinct audit rows', async () => {
    // No mutex / shared state in the wrapper — the providerPool serves
    // up to DB_PROVIDER_POOL_MAX (5) clients concurrently. Each call
    // writes ONE audit row; we must see 5, all with our reason marker.
    // Audit v1.1 CC-2 — reasons must pass quality bar. Ticket prefix
    // makes short markers valid.
    const MARKER = `TKT-1100: concurrent-${Date.now()}`;
    const reasons = Array.from({ length: 5 }, (_, i) => `${MARKER}-call-${i}`);
    await Promise.all(
      reasons.map((r) =>
        withProvider(provider.id, r, async () => undefined, {
          action: 'provider.tenant.viewed',
        }),
      ),
    );
    const client = await providerPool.connect();
    try {
      const result = await client.query<{ reason: string }>(
        `SELECT reason FROM provider_audit_log WHERE reason LIKE $1 ORDER BY reason ASC`,
        [`${MARKER}-%`],
      );
      const stored = result.rows.map((r) => r.reason).sort();
      expect(stored.length).toBe(5);
      expect(stored).toEqual(reasons.slice().sort());
    } finally {
      client.release();
    }
  });
});
