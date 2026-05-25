/**
 * AUDIT v1.1 - Closure verification tests.
 *
 * One spec file per closure batch. Each describe block names the
 * finding it pins; if the closure ever regresses the test name points
 * straight at the section of AUDIT-V1-1-PHASE6.5-FINDINGS.md that
 * documents the rationale.
 *
 * Strategy: pure-unit assertions where possible (no DB, no Nest
 * runtime). End-to-end / DB-backed assertions live in the relevant
 * service spec files (they get separate setup costs). Tests here
 * replace the Audit v1.1 it.todo markers landed in PR #42 - each
 * todo is now a real assertion.
 */
import {
  PROVIDER_ACTION_MAX_LEN,
  PROVIDER_ACTION_REGEX,
  PROVIDER_REASON_MAX_LEN,
  PROVIDER_REASON_MIN_LEN,
  PROVIDER_TICKET_REF_REGEX,
  validateProviderAction,
  validateProviderMetadata,
  validateProviderReason,
  validateProviderUserId,
} from '@emapp/db';
import { ProviderAuditQuerySchema } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { parseAccessReasonHeader } from './access-reason.decorator';
import { PROVIDER_AUDIT_SELECT_KEYS } from './provider-audit.service';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

// ===================================================================
// CC-2 + CC-3 + SA-13 - shared validators + quality bar.
// ===================================================================

describe('AUDIT v1.1 / CC-3 + SA-13 - validators exported from one place', () => {
  it('validateProviderUserId exists and rejects non-UUIDs', () => {
    const ok = validateProviderUserId('00000000-0000-4000-8000-000000000001');
    expect(ok.ok).toBe(true);
    const bad = validateProviderUserId('not-a-uuid');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('provider_user_id_invalid');
  });

  it('validateProviderAction enforces symmetric regex + length', () => {
    expect(validateProviderAction('provider.tenant.viewed').ok).toBe(true);
    const reallyBad = validateProviderAction('1starts-with-digit');
    expect(reallyBad.ok).toBe(false);
    if (!reallyBad.ok) expect(reallyBad.code).toBe('provider_action_invalid');
    const tooLong = validateProviderAction('a'.repeat(PROVIDER_ACTION_MAX_LEN + 1));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.code).toBe('provider_action_too_long');
  });

  it('validateProviderMetadata overlays reason on top of caller keys', () => {
    const r = validateProviderMetadata('the-real-reason', { reason: 'evil', other: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const parsed = JSON.parse(r.value) as Record<string, unknown>;
      expect(parsed['reason']).toBe('the-real-reason');
      expect(parsed['other']).toBe(1);
    }
  });

  it('validateProviderMetadata rejects > 8 KB payloads', () => {
    const r = validateProviderMetadata('reason', { big: 'x'.repeat(10_000) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('provider_metadata_too_large');
  });

  it('validateProviderMetadata rejects circular references', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    const r = validateProviderMetadata('reason', a);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('provider_metadata_invalid');
  });

  it('constants exported for downstream pin tests', () => {
    expect(PROVIDER_REASON_MIN_LEN).toBe(10);
    expect(PROVIDER_REASON_MAX_LEN).toBe(512);
    expect(PROVIDER_ACTION_REGEX.test('a.b-c_d')).toBe(true);
    expect(PROVIDER_TICKET_REF_REGEX.test('INC-1234')).toBe(true);
  });
});

describe('AUDIT v1.1 / CC-2 - access_reason quality (ISO A.9.4.1)', () => {
  const lowQuality = [
    'aaaaa',
    'test1',
    '.....',
    '12345',
    'aaaaaaaaaa',
    'aaaaaaaaaaaaaaaaaaaa',
    'aaa bbb',
  ];

  for (const r of lowQuality) {
    it(`REJECTS low-quality reason: ${JSON.stringify(r)}`, () => {
      const result = validateProviderReason(r);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['reason_required', 'reason_low_quality']).toContain(result.code);
      }
    });
  }

  const ticketReasons = [
    'INC-1234',
    'inc-1234',
    'INC-1234: investigating tenant signup failure',
    'SUP-9912 customer report',
    'TKT-001 anything goes after a real ticket id',
    'JIRA-OPS-456: rotation prep',
    'GH-789',
    'BUG-1001 urgent investigation',
  ];

  for (const r of ticketReasons) {
    it(`ACCEPTS ticket-pattern reason: ${JSON.stringify(r)}`, () => {
      expect(validateProviderReason(r).ok).toBe(true);
    });
  }

  const substantiveReasons = [
    'investigating tenant signup failure today',
    'billing reconciliation for Q2 quarter end',
    'health check after Neon outage last night',
    'manual onboarding for customer Acme Inc per phone request',
  ];

  for (const r of substantiveReasons) {
    it(`ACCEPTS substantive-text reason: ${JSON.stringify(r)}`, () => {
      expect(validateProviderReason(r).ok).toBe(true);
    });
  }

  it('strips CR/LF before length check (defeats audit-row CRLF injection)', () => {
    const r = validateProviderReason('INC-1234' + CR + LF + ': investigating issue ');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.indexOf(CR)).toBe(-1);
      expect(r.value.indexOf(LF)).toBe(-1);
    }
  });

  it('rejects > 512 chars after strip', () => {
    const r = validateProviderReason('INC-1234: ' + 'x'.repeat(600));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('reason_too_long');
  });

  it('rejects empty / undefined / non-string', () => {
    expect(validateProviderReason('').ok).toBe(false);
    expect(validateProviderReason(undefined).ok).toBe(false);
    expect(validateProviderReason(null).ok).toBe(false);
    expect(validateProviderReason(42).ok).toBe(false);
  });

  it('parseAccessReasonHeader (HTTP shim) maps validator codes to 400 bodies', () => {
    // BadRequestException stringifies as "Bad Request Exception" — to
    // assert on the error code we need to catch and inspect the body.
    function codeOf(fn: () => unknown): string | undefined {
      try {
        fn();
        return undefined;
      } catch (e) {
        const err = e as { getResponse?: () => unknown };
        const body = err.getResponse?.() as { error?: { code?: string } } | undefined;
        return body?.error?.code;
      }
    }
    expect(codeOf(() => parseAccessReasonHeader('aaaaa'))).toMatch(
      /reason_low_quality|reason_required/,
    );
    expect(codeOf(() => parseAccessReasonHeader(undefined))).toBe('reason_required');
    expect(codeOf(() => parseAccessReasonHeader(['one', 'two']))).toBe('reason_required');
    expect(parseAccessReasonHeader('INC-1234: legitimate')).toBe('INC-1234: legitimate');
  });
});

// ===================================================================
// SA-4 - audit search date-range cap (DoS guard, ISO A.12.1.3).
// ===================================================================

describe('AUDIT v1.1 / SA-4 - audit search must filter by orgId OR <=31d span', () => {
  const orgId = '00000000-0000-4000-8000-000000000123';

  it('ACCEPTS orgId-only query (no date)', () => {
    const r = ProviderAuditQuerySchema.safeParse({ orgId });
    expect(r.success).toBe(true);
  });

  it('ACCEPTS fromDate-only when toDate defaults to now and span <=31d', () => {
    const r = ProviderAuditQuerySchema.safeParse({
      fromDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(r.success).toBe(true);
  });

  it('ACCEPTS narrow date window without orgId', () => {
    const from = new Date('2026-04-01T00:00:00Z');
    const to = new Date('2026-04-15T00:00:00Z');
    const r = ProviderAuditQuerySchema.safeParse({
      fromDate: from.toISOString(),
      toDate: to.toISOString(),
    });
    expect(r.success).toBe(true);
  });

  it('REJECTS no filters at all (the DoS surface)', () => {
    const r = ProviderAuditQuerySchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('REJECTS date span > 31 days without orgId', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-04-01T00:00:00Z');
    const r = ProviderAuditQuerySchema.safeParse({
      fromDate: from.toISOString(),
      toDate: to.toISOString(),
    });
    expect(r.success).toBe(false);
  });

  it('ACCEPTS wide date span WHEN orgId is supplied', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-12-31T00:00:00Z');
    const r = ProviderAuditQuerySchema.safeParse({
      orgId,
      fromDate: from.toISOString(),
      toDate: to.toISOString(),
    });
    expect(r.success).toBe(true);
  });

  it('preserves existing fromDate<=toDate refinement', () => {
    const r = ProviderAuditQuerySchema.safeParse({
      orgId,
      fromDate: '2026-04-01T00:00:00Z',
      toDate: '2026-03-01T00:00:00Z',
    });
    expect(r.success).toBe(false);
  });
});

// ===================================================================
// SA-5 - audit projection allowlist (PII surface guard).
// ===================================================================

describe('AUDIT v1.1 / SA-5 - audit projection allowlist (PII surface guard)', () => {
  const EXPECTED = [
    'id',
    'organizationId',
    'actorId',
    'actorType',
    'action',
    'targetTable',
    'targetId',
    'createdAt',
  ];

  it('PROVIDER_AUDIT_SELECT_KEYS matches the frozen allowlist', () => {
    expect([...PROVIDER_AUDIT_SELECT_KEYS].sort()).toEqual([...EXPECTED].sort());
  });

  it('allowlist does NOT include known PII-bearing audit columns', () => {
    const forbidden = ['beforeState', 'afterState', 'actorEmail', 'ip', 'userAgent', 'metadata'];
    for (const k of forbidden) {
      expect(PROVIDER_AUDIT_SELECT_KEYS).not.toContain(k);
    }
  });
});

// ===================================================================
// CC-1 - trustProxy: 1 (audit-log IP attribution).
// ===================================================================

describe('AUDIT v1.1 / CC-1 - trustProxy:1 (audit IP attribution)', () => {
  it('main.ts uses trustProxy:1 (NOT true)', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.resolve(__dirname, '../../main.ts'), 'utf8');
    // Strip comments + strings before checking — we care about the
    // actual setting, not the rationale text in JSDoc.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).toMatch(/trustProxy:\s*1\b/);
    expect(codeOnly).not.toMatch(/trustProxy:\s*true/);
  });
});

// ===================================================================
// SA-15 - CORS allows the access_reason header.
// ===================================================================

describe('AUDIT v1.1 / SA-15 - CORS allows access_reason header', () => {
  it('main.ts allowedHeaders includes "access_reason"', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.resolve(__dirname, '../../main.ts'), 'utf8');
    expect(src).toMatch(/allowedHeaders:[\s\S]*?'access_reason'/);
  });
});

// ===================================================================
// SA-3 - JWT role from DB (not hardcoded).
// ===================================================================

describe('AUDIT v1.1 / SA-3 - JWT role from DB (not hardcoded literal)', () => {
  it('provider-auth.service.ts does NOT hardcode role:"provider_admin" in signAccess', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, '../auth/provider/provider-auth.service.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/role:\s*['"]provider_admin['"]\s*,\s*sid/);
    expect(src).toMatch(/signAccess\(\s*sub:\s*string,\s*role:\s*ProviderJwtRole/);
  });
});

// ===================================================================
// CC-8 - dead void import statements removed.
// ===================================================================

describe('AUDIT v1.1 / CC-8 - dead void <import> statements removed', () => {
  it('with-provider.ts no longer has void providerAuditLog', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../../../packages/db/src/wrappers/with-provider.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/void\s+providerAuditLog/);
  });

  it('provider-tenant-detail.service.ts no longer has void eq', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, './provider-tenant-detail.service.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/void\s+eq;/);
  });
});

// ===================================================================
// SA-7 - autonomous audit tx (cross-references with-provider.ts shape).
// ===================================================================

describe('AUDIT v1.1 / SA-7 - withProvider uses autonomous audit tx', () => {
  it('with-provider.ts uses TWO pool connections (audit + work)', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../../../packages/db/src/wrappers/with-provider.ts'),
      'utf8',
    );
    const connectCount = (src.match(/providerPool\.connect\(\)/g) ?? []).length;
    expect(connectCount).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(
      /INSERT INTO provider_audit_log[\s\S]+?COMMIT[\s\S]+?providerPool\.connect/,
    );
  });
});
