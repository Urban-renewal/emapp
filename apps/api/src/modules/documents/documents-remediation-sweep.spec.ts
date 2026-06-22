/**
 * FL-5 (MASTER-PLAN-V13 Wave A) — DocumentsService.remediationSweep INTEGRATION
 * spec. Closes the #450 HIGH follow-up: pre-existing נסח/tabu-content docs that
 * predate the DH3 classifier were never typed `land_registry` and never derived
 * `sensitive = true`. The sweep re-classifies them (from stored filename+mime —
 * no content fetch) and, in APPLY mode, turns the flag ON.
 *
 * Pins, against the real local DB harness (same as documents-classify.spec):
 *   - DRY-RUN (default) REPORTS proposed changes but COMMITS NOTHING (DB
 *     unchanged after; applied=false);
 *   - APPLY (dryRun:false) re-types the targeted docs to land_registry +
 *     sensitive=true;
 *   - IDEMPOTENT: a second apply is a no-op (candidates=0; rows untouched);
 *   - an already-correctly-classified (land_registry, sensitive) doc is never a
 *     candidate;
 *   - a NON-tabu doc is NOT misclassified as land_registry (no false-positive
 *     sensitivity flip);
 *   - the report carries NO filename / content / PII (only ids + transitions +
 *     content-free reason keys);
 *   - sensitivity is NEVER weakened (an already-sensitive doc keeps it).
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/documents/documents-remediation-sweep.spec.ts
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { documents, withTenant } from '@emapp/db';
import { RemediationSweepResultSchema } from '@emapp/shared-types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { DocumentsService } from './documents.service';

let svc: DocumentsService;
let orgA: TestOrg;
let mgrId: string;

// The sweep now re-encrypts a re-typed PLAINTEXT object IN PLACE (Gate-6) when it
// flips a doc sensitive — so storage must serve PLAINTEXT bytes (read → envelope
// → putObject no-op). Scan + notify are still untouched by the sweep.
const storageStub = {
  getObjectStream: async () =>
    Readable.from([Buffer.from('%PDF-1.4 plaintext נסח source bytes %%EOF')]),
  putObject: async () => undefined,
} as never;
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

/** Insert a raw document row directly (RLS via withTenant). Returns its id. */
async function insertDoc(opts: {
  name: string;
  type: string;
  sensitive?: boolean;
  mimeType?: string;
}): Promise<string> {
  return withTenant(orgA.id, async (tx) => {
    const [row] = await tx
      .insert(documents)
      .values({
        orgId: orgA.id,
        name: opts.name,
        type: opts.type,
        mimeType: opts.mimeType ?? 'application/pdf',
        sizeBytes: 1024,
        r2Key: `org/${orgA.id}/${randomUUID()}`,
        contentHash: randomUUID().replace(/-/g, ''),
        uploadedBy: mgrId,
        sensitive: opts.sensitive ?? false,
        uploadedAt: new Date(),
        scanStatus: 'clean',
      })
      .returning({ id: documents.id });
    return row!.id;
  });
}

async function readDoc(id: string): Promise<{ type: string; sensitive: boolean } | undefined> {
  return withTenant(orgA.id, async (tx) => {
    const [row] = await tx
      .select({ type: documents.type, sensitive: documents.sensitive })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    return row;
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new DocumentsService(storageStub, scanStub, notificationsStub);
  // Unique tag so re-runs against a dirty local DB don't collide on the org slug
  // (the fixed-slug pattern is fine in CI's fresh DB but bites on local re-run).
  orgA = await createTestOrg(`remediation-${Date.now()}`);
  mgrId = orgA.users.find((u) => u.role === 'manager')!.id;
});

afterAll(async () => {
  // createTestOrg owns its org; the per-test docs live under it.
});

describe('FL-5 · DocumentsService.remediationSweep (dry-run-default, idempotent)', () => {
  it('DRY-RUN (default) reports the tabu candidate and COMMITS NOTHING', async () => {
    // A pre-DH3 נסח doc stored as the generic `other`, NOT sensitive.
    const tabuId = await insertDoc({ name: 'נסח טאבו ישן.pdf', type: 'other', sensitive: false });

    const r = await svc.remediationSweep(manager(), { dryRun: true, limit: 1000 });
    expect(RemediationSweepResultSchema.safeParse(r).success).toBe(true);
    expect(r.applied).toBe(false);

    const item = r.sample.find((s) => s.documentId === tabuId);
    expect(item).toBeDefined();
    expect(item?.fromType).toBe('other');
    expect(item?.toType).toBe('land_registry');
    expect(item?.wasSensitive).toBe(false);
    expect(item?.willBeSensitive).toBe(true);

    // CRITICAL: nothing was written — the doc is byte-for-byte unchanged.
    const after = await readDoc(tabuId);
    expect(after?.type).toBe('other');
    expect(after?.sensitive).toBe(false);
  });

  it('APPLY (dryRun:false) re-types the tabu doc → land_registry + sensitive', async () => {
    const tabuId = await insertDoc({
      name: 'tabu_extract_2021.pdf',
      type: 'document',
      sensitive: false,
    });

    const r = await svc.remediationSweep(manager(), { dryRun: false, limit: 1000 });
    expect(r.applied).toBe(true);
    expect(r.sample.some((s) => s.documentId === tabuId)).toBe(true);

    const after = await readDoc(tabuId);
    expect(after?.type).toBe('land_registry');
    expect(after?.sensitive).toBe(true);
  });

  it('IDEMPOTENT: a second apply is a no-op (the fixed doc is no longer a candidate)', async () => {
    const tabuId = await insertDoc({ name: 'נסח רישום.pdf', type: 'other', sensitive: false });

    // First apply fixes it.
    const r1 = await svc.remediationSweep(manager(), { dryRun: false, limit: 1000 });
    expect(r1.sample.some((s) => s.documentId === tabuId)).toBe(true);
    const mid = await readDoc(tabuId);
    expect(mid?.type).toBe('land_registry');
    expect(mid?.sensitive).toBe(true);

    // Second apply: this doc is already land_registry → excluded from the
    // candidate set → never re-touched.
    const r2 = await svc.remediationSweep(manager(), { dryRun: false, limit: 1000 });
    expect(r2.sample.some((s) => s.documentId === tabuId)).toBe(false);

    const after = await readDoc(tabuId);
    expect(after?.type).toBe('land_registry');
    expect(after?.sensitive).toBe(true);
  });

  it('an already-correctly-classified land_registry doc is never a candidate', async () => {
    const okId = await insertDoc({ name: 'נסח טאבו.pdf', type: 'land_registry', sensitive: true });
    const r = await svc.remediationSweep(manager(), { dryRun: true, limit: 1000 });
    expect(r.sample.some((s) => s.documentId === okId)).toBe(false);
  });

  it('a NON-tabu doc is NOT misclassified as land_registry (no false-positive flip)', async () => {
    const agreementId = await insertDoc({
      name: 'הסכם התחדשות.pdf',
      type: 'agreement',
      sensitive: false,
    });
    const blueprintId = await insertDoc({
      name: 'תוכנית בניין.pdf',
      type: 'blueprint',
      sensitive: false,
    });
    const genericId = await insertDoc({ name: 'מסמך כללי.pdf', type: 'other', sensitive: false });

    // Apply — none of these should change.
    await svc.remediationSweep(manager(), { dryRun: false, limit: 1000 });

    for (const id of [agreementId, blueprintId, genericId]) {
      const after = await readDoc(id);
      expect(after?.type).not.toBe('land_registry');
      expect(after?.sensitive).toBe(false);
    }
  });

  it('the report carries NO filename / content / PII — ids + transitions + reason keys only', async () => {
    const piiName = 'נסח טאבו של ישראל ישראלי ת.ז 123456789.pdf';
    await insertDoc({ name: piiName, type: 'other', sensitive: false });

    const r = await svc.remediationSweep(manager(), { dryRun: true, limit: 1000 });
    const serialized = JSON.stringify(r);
    // The filename (and the embedded national_id) must NEVER appear in the report.
    expect(serialized).not.toContain('ישראל');
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain('.pdf');
    // Reason keys are the DH3 content-free constants.
    const item = r.sample.find(
      (s) => s.reason.startsWith('filename_') || s.reason.startsWith('content_'),
    );
    expect(item).toBeDefined();
  });

  it('sensitivity is NEVER weakened — an already-sensitive tabu doc keeps sensitive=true', async () => {
    // A doc that is sensitive but mis-typed (e.g. tagged id_document) and whose
    // filename is tabu: the sweep retypes to land_registry but must keep
    // sensitive=true (never flip it off).
    const id = await insertDoc({ name: 'נסח טאבו רגיש.pdf', type: 'id_document', sensitive: true });
    await svc.remediationSweep(manager(), { dryRun: false, limit: 1000 });
    const after = await readDoc(id);
    expect(after?.type).toBe('land_registry');
    expect(after?.sensitive).toBe(true);
  });
});
