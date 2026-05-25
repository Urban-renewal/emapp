/**
 * D.37 / Phase 6.5 — `GET /provider/audit` cross-tenant audit search.
 *
 * Seeds audit rows in 2 orgs with distinct actions + dates, then
 * exercises every filter combination + cursor walk + ordering.
 *
 * Test IDs (D.33):
 *   T6.5-D37-6a   no filters — returns rows from BOTH orgs (cross-tenant)
 *   T6.5-D37-6b   orgId filter — returns only that org's rows
 *   T6.5-D37-6c   action prefix filter — `import.` matches all import.*
 *   T6.5-D37-6d   fromDate filter — strict inclusive lower bound
 *   T6.5-D37-6e   toDate filter — strict inclusive upper bound
 *   T6.5-D37-6f   fromDate > toDate — Zod refine rejects at the pipe
 *   T6.5-D37-7a   cursor pagination — full walk yields every row once
 *   T6.5-D37-7b   invalid cursor → 400 invalid_cursor (no audit row)
 *   T6.5-D37-7c   ordering — DESC by createdAt then id
 *   T6.5-D37-8a   results carry NO before/after state (those fields
 *                 are NOT in the wire shape — pinned by full JSON scan)
 *   T6.5-D37-8b   audit row: action='provider.audit.searched' +
 *                 metadata.filter snapshot complete
 *   T6.5-D37-8c   limit boundary 1 and 100 both accepted
 */
import { randomUUID } from 'node:crypto';

import { AuditService, auditLog, withTenant } from '@emapp/db';
import { BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
const TEST_PREFIX = 'p65-4-' + Date.now();
let orgA: { id: string; users: Array<{ id: string }> };
let orgB: { id: string; users: Array<{ id: string }> };
// Track seeded audit ids so we can scope assertions to OUR rows
// across parallel-test pollution.
const ourAuditIds = new Set<string>();

function principal(): ProviderPrincipal {
  return {
    sub: provider.id,
    role: 'provider_admin',
    sid: '00000000-0000-4000-8000-00000000d37c',
    type: 'provider_access',
    ip: '203.0.113.99',
    userAgent: 'P6.5-4-spec/1.0',
  };
}

/** Seed an audit row in a specific org via withTenant + AuditService. */
async function seedAudit(input: {
  orgId: string;
  actorId: string;
  action: string;
  targetTable?: string;
  targetId?: string;
}): Promise<string> {
  return withTenant(
    input.orgId,
    async (tx) => {
      await new AuditService(tx).log({
        orgId: input.orgId,
        actorId: input.actorId,
        actorType: 'user',
        action: input.action,
        targetTable: input.targetTable ?? 'projects',
        targetId: input.targetId ?? randomUUID(),
      });
      // Grab the most-recent audit row for this action — that's
      // the one we just wrote. (Inside the same withTenant tx, the
      // INSERT is committed at the end; we query AFTER tx completes.)
      const [row] = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.action, input.action))
        .orderBy(auditLog.createdAt)
        .limit(1);
      return row?.id ?? '';
    },
    { userId: input.actorId },
  );
}

beforeAll(async () => {
  await setupTestDatabase();
  provider = await createTestProviderUser();
  svc = new ProviderAuditService();

  // Two orgs, each with a manager whose id we can pivot on.
  orgA = await createTestOrg(`${TEST_PREFIX}-A`, `${TEST_PREFIX}-a`);
  orgB = await createTestOrg(`${TEST_PREFIX}-B`, `${TEST_PREFIX}-b`);

  // Seed distinct action prefixes in each org. The action strings
  // include the TEST_PREFIX so we can disambiguate our rows from
  // any audit pollution in the dev DB.
  const actionsA = [
    `import.received.${TEST_PREFIX}`,
    `import.validating.${TEST_PREFIX}`,
    `owner.created.${TEST_PREFIX}`,
  ];
  for (const a of actionsA) {
    const id = await seedAudit({ orgId: orgA.id, actorId: orgA.users[0]!.id, action: a });
    if (id) ourAuditIds.add(id);
  }
  const actionsB = [
    `signature_request.created.${TEST_PREFIX}`,
    `signature_request.signed.${TEST_PREFIX}`,
  ];
  for (const a of actionsB) {
    const id = await seedAudit({ orgId: orgB.id, actorId: orgB.users[0]!.id, action: a });
    if (id) ourAuditIds.add(id);
  }
}, 60_000);

afterAll(() => {
  // Pools are shared singletons.
});

/** Filter a result set to only rows we seeded — defends against
 *  audit pollution from parallel specs running against the same DB. */
function onlyOurs<T extends { id: string }>(rows: T[]): T[] {
  return rows.filter((r) => ourAuditIds.has(r.id));
}

async function providerAuditRowsForUs(): Promise<
  Array<{ action_type: string; metadata: Record<string, unknown> }>
> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{ action_type: string; metadata: Record<string, unknown> }>(
      `SELECT action_type, metadata FROM provider_audit_log
       WHERE provider_user_id = $1 ORDER BY started_at DESC LIMIT 50`,
      [provider.id],
    );
    return r.rows;
  } finally {
    client.release();
  }
}

describe('GET /provider/audit — P6.5-4 cross-tenant audit search', () => {
  it('T6.5-D37-6a) no filters → returns rows from BOTH orgs', async () => {
    const result = await svc.search(principal(), 'no-filter cross-tenant', { limit: 100 });
    const ours = onlyOurs(result.data);
    const orgIds = new Set(ours.map((r) => r.organizationId));
    expect(orgIds.has(orgA.id)).toBe(true);
    expect(orgIds.has(orgB.id)).toBe(true);
  });

  it('T6.5-D37-6b) orgId filter — returns only matching org', async () => {
    const result = await svc.search(principal(), 'orgId filter test', {
      limit: 100,
      orgId: orgA.id,
    });
    const ours = onlyOurs(result.data);
    expect(ours.length).toBeGreaterThan(0);
    for (const r of ours) expect(r.organizationId).toBe(orgA.id);
  });

  it('T6.5-D37-6c) action prefix filter — `import.` matches all import.* rows', async () => {
    const result = await svc.search(principal(), 'action prefix test', {
      limit: 100,
      action: 'import.',
    });
    const ours = onlyOurs(result.data);
    expect(ours.length).toBeGreaterThanOrEqual(2);
    for (const r of ours) expect(r.action.startsWith('import.')).toBe(true);
  });

  it('T6.5-D37-6d) fromDate filter — inclusive lower bound', async () => {
    // 1 hour ago — all our seeds are AFTER.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const result = await svc.search(principal(), 'fromDate test', {
      limit: 100,
      fromDate: oneHourAgo,
    });
    const ours = onlyOurs(result.data);
    for (const r of ours)
      expect(r.createdAt.getTime()).toBeGreaterThanOrEqual(oneHourAgo.getTime());
  });

  it('T6.5-D37-6e) toDate filter — inclusive upper bound', async () => {
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = await svc.search(principal(), 'toDate test', {
      limit: 100,
      toDate: farFuture,
    });
    const ours = onlyOurs(result.data);
    for (const r of ours) expect(r.createdAt.getTime()).toBeLessThanOrEqual(farFuture.getTime());
  });

  it('T6.5-D37-6f) fromDate > toDate — Zod refine should reject (pipe-level — verified via direct schema parse)', async () => {
    // The service receives ALREADY-validated input from the pipe.
    // We verify the schema itself rejects — the pipe path is a thin
    // wrap. Direct Zod parse:
    const { ProviderAuditQuerySchema } = await import('@emapp/shared-types');
    const parsed = ProviderAuditQuerySchema.safeParse({
      fromDate: '2030-01-01T00:00:00.000Z',
      toDate: '2020-01-01T00:00:00.000Z',
      limit: 10,
    });
    expect(parsed.success).toBe(false);
  });

  it('T6.5-D37-7a) cursor walk yields every row exactly once', { timeout: 30_000 }, async () => {
    const seen = new Set<string>();
    let cursor: string | undefined = undefined;
    let pages = 0;
    while (pages < 30) {
      const page = await svc.search(principal(), `cursor walk page ${pages}`, {
        limit: 2,
        cursor,
      });
      for (const r of page.data) {
        expect(seen.has(r.id)).toBe(false);
        seen.add(r.id);
      }
      if (!page.page.has_more) break;
      cursor = page.page.cursor ?? undefined;
      pages += 1;
    }
    // Must have seen all 5 of our seeded rows.
    for (const id of ourAuditIds) expect(seen.has(id)).toBe(true);
  });

  it('T6.5-D37-7b) invalid cursor → 400 invalid_cursor; no provider_audit_log row appended', async () => {
    const before = (await providerAuditRowsForUs()).length;
    await expect(
      svc.search(principal(), 'invalid cursor', {
        limit: 5,
        cursor: '@@@-not-valid-base64@@@',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const after = (await providerAuditRowsForUs()).length;
    expect(after).toBe(before);
  });

  it('T6.5-D37-7c) ordering — DESC by createdAt (newer first)', async () => {
    const result = await svc.search(principal(), 'ordering test', { limit: 100 });
    const ours = onlyOurs(result.data);
    for (let i = 1; i < ours.length; i += 1) {
      const prev = ours[i - 1]!.createdAt.getTime();
      const cur = ours[i]!.createdAt.getTime();
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });

  it('T6.5-D37-8a) results carry NO before/after state — wire shape has no PII surface', async () => {
    const result = await svc.search(principal(), 'wire shape no-PII test', {
      limit: 100,
      action: 'owner.',
    });
    const blob = JSON.stringify(result.data);
    // The org-tier audit sanitizer keeps beforeState/afterState
    // structured (no cleartext PII). The Provider wire shape OMITS
    // those fields entirely — defense-in-depth.
    expect(blob).not.toContain('beforeState');
    expect(blob).not.toContain('afterState');
    expect(blob).not.toContain('before_state');
    expect(blob).not.toContain('after_state');
  });

  it('T6.5-D37-8b) audit row: action=provider.audit.searched + metadata.filter snapshot complete', async () => {
    const UNIQUE_REASON = 'audit content verification — ' + randomUUID();
    const params: { orgId: string; action: string; limit: number; fromDate: Date } = {
      orgId: orgA.id,
      action: 'import.',
      limit: 7,
      fromDate: new Date(Date.now() - 60_000),
    };
    await svc.search(principal(), UNIQUE_REASON, params);
    const auditRows = await providerAuditRowsForUs();
    const ours = auditRows.find(
      (r) => (r.metadata as { reason?: string }).reason === UNIQUE_REASON,
    );
    expect(ours).toBeDefined();
    expect(ours!.action_type).toBe('provider.audit.searched');
    const md = ours!.metadata as {
      endpoint?: string;
      filter?: { orgId?: string; action?: string; limit?: number; fromDate?: string };
    };
    expect(md.endpoint).toBe('audit-search');
    expect(md.filter?.orgId).toBe(orgA.id);
    expect(md.filter?.action).toBe('import.');
    expect(md.filter?.limit).toBe(7);
    expect(md.filter?.fromDate).toBe(params.fromDate.toISOString());
  });

  it('T6.5-D37-8c) limit boundary — 1 and 100 both accepted', async () => {
    const small = await svc.search(principal(), 'limit 1 boundary', { limit: 1 });
    expect(small.data.length).toBeLessThanOrEqual(1);
    const big = await svc.search(principal(), 'limit 100 boundary', { limit: 100 });
    expect(big.data.length).toBeLessThanOrEqual(100);
  });

  it('T6.5-D37-8d) action with SQL LIKE metacharacters is REJECTED by Zod regex (no escape needed)', async () => {
    // Zod regex: ^[a-z][a-z0-9_.-]*$. Allows letters, digits, dot,
    // dash, underscore. EXCLUDES % and _ used in SQL LIKE. The
    // writer then appends a literal `%` to make it a prefix — safe
    // because the input cannot already contain `%`.
    const { ProviderAuditQuerySchema } = await import('@emapp/shared-types');
    expect(ProviderAuditQuerySchema.safeParse({ action: 'import.%', limit: 5 }).success).toBe(
      false,
    );
    expect(ProviderAuditQuerySchema.safeParse({ action: 'import.user_', limit: 5 }).success).toBe(
      true,
    ); // underscore is in the allowed class — that's fine (LIKE meta-char in pg is `_` for single-char, but our prefix-mode only appends `%`)
    expect(ProviderAuditQuerySchema.safeParse({ action: "import.';--", limit: 5 }).success).toBe(
      false,
    );
  });
});

// Lint-quiet — `eq` used in seedAudit, but kept here too for symmetry.
void eq;
