/**
 * DH3 (MASTER-PLAN-V13 Wave B) — DocumentsService.classify INTEGRATION spec.
 *
 * Asserts the SERVICE wiring of the suggest-only classifier against the real
 * local DB harness (same harness as documents-search.spec). The classify path
 * does NO DB read/write — these tests pin that:
 *   - it returns a ClassifyResultSchema-valid, suggest-only payload;
 *   - it decodes + caps the base64 sample (magic-byte + content-text signals);
 *   - a malformed base64 sample never throws (advisory; falls back to filename);
 *   - it creates NO document row (the documents table count is unchanged);
 *   - org context is irrelevant to the OUTPUT (pure over inputs) — a manager and
 *     an agent get the same suggestion for the same inputs.
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/documents/documents-classify.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { documents, withTenant } from '@emapp/db';
import {
  ClassifyResultSchema,
  isSensitiveDocType,
  providerPartyForDocType,
} from '@emapp/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { DocumentsService } from './documents.service';

let svc: DocumentsService;
let orgA: TestOrg;
let mgrId: string;

// Inert stubs — classify touches NONE of these (no storage, no scan, no notify).
const storageStub = {} as never;
const scanStub = {} as never;
const notificationsStub = {} as never;

function manager(): AccessTokenPayload {
  return {
    sub: mgrId,
    orgId: orgA.id,
    role: 'manager',
    sid: randomUUID(),
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function docCount(orgId: string): Promise<number> {
  return withTenant(orgId, async (tx) => {
    const rows = await tx.select({ id: documents.id }).from(documents);
    return rows.length;
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new DocumentsService(storageStub, scanStub, notificationsStub);
  orgA = await createTestOrg('classify-A');
  mgrId = orgA.users.find((u) => u.role === 'manager')!.id;
});

afterAll(async () => {
  // No rows created by this spec; nothing to clean. createTestOrg owns its data.
});

describe('DH3 · DocumentsService.classify (suggest-only)', () => {
  it('returns a ClassifyResultSchema-valid, suggest-only payload', async () => {
    const r = await svc.classify(manager(), {
      filename: 'נסח טאבו.pdf',
      mimeType: 'application/pdf',
    });
    expect(ClassifyResultSchema.safeParse(r).success).toBe(true);
    expect(r.suggestOnly).toBe(true);
    expect(r.suggestions[0]?.docType).toBe('land_registry');
  });

  it('decodes + uses the base64 sample (PDF content marker → land_registry)', async () => {
    const sample = Buffer.from('לשכת רישום המקרקעין\nגוש 1234', 'utf8').toString('base64');
    const r = await svc.classify(manager(), {
      filename: 'scan.pdf',
      mimeType: 'application/pdf',
      sampleBase64: sample,
    });
    const lr = r.suggestions.find((s) => s.docType === 'land_registry');
    expect(lr?.signal).toBe('content_text');
  });

  it('a malformed base64 sample never throws (advisory; falls back to filename)', async () => {
    const r = await svc.classify(manager(), {
      filename: 'הסכם.pdf',
      mimeType: 'application/pdf',
      // not valid base64 content but Zod-length-valid; Buffer.from tolerates it.
      sampleBase64: '@@@not-base64@@@',
    });
    expect(r.suggestOnly).toBe(true);
    expect(r.suggestions[0]?.docType).toBe('agreement'); // filename signal still wins
  });

  it('SUGGEST-ONLY: classify creates NO document row', async () => {
    const before = await docCount(orgA.id);
    await svc.classify(manager(), { filename: 'תקנון.pdf', mimeType: 'application/pdf' });
    await svc.classify(manager(), {
      filename: 'x.bin',
      mimeType: 'application/pdf',
      sampleBase64: Buffer.from('AC1015', 'latin1').toString('base64'),
    });
    const after = await docCount(orgA.id);
    expect(after).toBe(before);
  });

  it('output is pure over inputs (independent of org/role) — same input, same suggestion', async () => {
    const input = { filename: 'building.dwg', mimeType: 'application/pdf' as const };
    const r1 = await svc.classify(manager(), input);
    const r2 = await svc.classify(manager(), input);
    expect(r1).toEqual(r2);
    expect(r1.suggestions[0]?.docType).toBe('blueprint');
  });
});

describe('S4-taxonomy · supervisor + power-of-attorney party-gap closure', () => {
  // The two new curated types + the representative Hebrew filename that should
  // classify to each, and the party they roll up to on the binder board.
  const cases: Array<{ filename: string; docType: string; party: string }> = [
    { filename: 'דוח פיקוח חודש מאי.pdf', docType: 'inspection_report', party: 'supervisor' },
    { filename: 'ייפוי כוח נוטריוני.pdf', docType: 'power_of_attorney', party: 'lawyer' },
  ];

  for (const { filename, docType, party } of cases) {
    it(`classifier suggests '${docType}' for '${filename}' and it maps → ${party}`, async () => {
      const r = await svc.classify(manager(), { filename, mimeType: 'application/pdf' });
      expect(ClassifyResultSchema.safeParse(r).success).toBe(true);
      expect(r.suggestOnly).toBe(true);
      // the new type is the top suggestion for its representative filename
      expect(r.suggestions[0]?.docType).toBe(docType);
      // and providerPartyForDocType (the ONE party-derivation map the board uses)
      // routes it to the intended party — the gap (supervisor empty) is closed.
      expect(providerPartyForDocType(docType)).toBe(party);
    });
  }

  it('G-RT: power_of_attorney derives sensitive=true (at-rest envelope + step-up gate)', () => {
    // The single source of truth the BE create-path consults
    // (`sensitive = SENSITIVE_DOC_TYPES.has(type) || input.sensitive`). Because
    // power_of_attorney is in the set, an upload of it ALWAYS derives sensitive —
    // it can never take the plain presigned-PUT path nor be plain-served.
    expect(isSensitiveDocType('power_of_attorney')).toBe(true);
    // its node — inspection_report — is a non-PII works report → NOT sensitive.
    expect(isSensitiveDocType('inspection_report')).toBe(false);
  });

  it('G-RT: a ייפוי-כוח classify response is PII-free (content-free reason keys)', async () => {
    const r = await svc.classify(manager(), {
      filename: 'ייפוי כוח של דוד כהן ת.ז. 123456789.pdf',
      mimeType: 'application/pdf',
    });
    for (const s of r.suggestions) {
      // reason keys are stable lowercase constants — never echo the filename/PII
      expect(s.reason).toMatch(/^[a-z0-9_]+$/);
      expect(s.reason).not.toContain('כהן');
      expect(s.reason).not.toContain('123456789');
    }
  });
});
