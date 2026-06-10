/**
 * P0.B1 — anti-malware scan gate (real-DB, service-level smoke).
 *
 * The change under test: `DocumentsService` now injects an `IFileScanProvider`
 * (3rd constructor arg). `finalize()` scans the uploaded object AFTER the
 * integrity check and stamps `scan_status`; the download path
 * (`getDownloadUrl` → `loadVisible(requireUploaded=true)`) serves ONLY a
 * `scan_status='clean'` document. FAIL-CLOSED: infected / error / unscanned
 * are never downloadable.
 *
 * Pins (each LOAD-BEARING):
 *  S1  clean verdict (NoopFileScanProvider) → finalize resolves; the doc is
 *      then downloadable (presigned URL minted). Proves the gate does not
 *      over-block legitimate files.
 *  S2  infected verdict → finalize throws 409 `document_scan_rejected`, the
 *      object is purged (storage.delete called), the row is archived, and a
 *      later download is NOT servable (generic 404 — archived).
 *  S3  error verdict (engine unreachable) → finalize throws 409
 *      `document_scan_rejected` (fail-closed: a scan that can't complete is
 *      treated as NOT clean), object purged.
 *  S4  a scanner that THROWS → still fail-closed (409, purged) — defends the
 *      "never throw" contract at the call site.
 *
 * Mirrors documents-ghost-doc.spec.ts (createTestOrg + service-level calls,
 * deterministic, sidesteps the signup throttler). A stub IStorageProvider
 * records delete() calls and serves a small in-memory stream for the scanner's
 * lazy byte loader.
 */
import { Readable } from 'node:stream';

import {
  NoopFileScanProvider,
  type IFileScanProvider,
  type IStorageProvider,
  type ScanResult,
} from '@emapp/db';
import { DOCUMENT_SCAN_REJECTED_CODE } from '@emapp/shared-types';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { DocumentsService } from './documents.service';

const PUT_URL = 'https://r2.example.test/presigned-put';
const GET_URL = 'https://r2.example.test/presigned-get';

/** A stub scanner that returns a fixed verdict (or throws). */
class StubScanProvider implements IFileScanProvider {
  constructor(private readonly behavior: ScanResult | 'throw') {}
  async scan(): Promise<ScanResult> {
    if (this.behavior === 'throw') throw new Error('boom: scanner crashed');
    return this.behavior;
  }
  async healthCheck(): Promise<void> {}
}

/** Stub storage: serves a tiny byte stream for the scanner's lazy loader and
 *  RECORDS delete() calls so the purge-on-reject assertion is exact. */
class RecordingStorage implements IStorageProvider {
  public readonly deleted: string[] = [];
  async getUploadUrl(): Promise<string> {
    return PUT_URL;
  }
  async getDownloadUrl(): Promise<string> {
    return GET_URL;
  }
  async head(): Promise<null> {
    return null; // no storage attestation → finalize layer-1 stands
  }
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
  }
  async getObjectStream(): Promise<Readable> {
    return Readable.from([Buffer.from('%PDF-1.4 fake bytes')]);
  }
  async healthCheck(): Promise<void> {}
}

let org: TestOrg;
let managerId: string;
let projectId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000c1';

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function makeSvc(storage: IStorageProvider, scanner: IFileScanProvider): DocumentsService {
  return new DocumentsService(storage, scanner, new NotificationsProducerService());
}

/** Run create → finalize through the given scanner, returning the doc id +
 *  the finalize outcome (resolved doc or thrown error). */
async function createAndFinalize(svc: DocumentsService): Promise<{ id: string; thrown?: unknown }> {
  const created = await svc.create(manager(), {
    name: 'plan.pdf',
    type: 'other',
    mimeType: 'application/pdf',
    sizeBytes: 100,
    contentHash: 'h-scan-gate',
    projectId,
  });
  const id = created.document.id;
  try {
    await svc.finalize(manager(), id, { sizeBytes: 100, contentHash: 'h-scan-gate' });
    return { id };
  } catch (e) {
    return { id, thrown: e };
  }
}

function errCode(e: unknown): string | undefined {
  if (e instanceof Error && 'getResponse' in e) {
    const body = (e as { getResponse: () => unknown }).getResponse();
    const code = (body as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

beforeAll(async () => {
  await setupTestDatabase();
  const tag = `scan-gate-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('P0.B1 — document anti-malware scan gate (real-DB)', () => {
  it('S1) CLEAN (Noop) → finalize ok + doc becomes downloadable', async () => {
    const storage = new RecordingStorage();
    const svc = makeSvc(storage, new NoopFileScanProvider());
    const { id, thrown } = await createAndFinalize(svc);
    expect(thrown, 'a clean file must finalize without throwing').toBeUndefined();
    // Now downloadable — the gate let the clean doc through.
    const dl = await svc.getDownloadUrl(manager(), id);
    expect(dl.url).toBe(GET_URL);
    // A clean file is never purged.
    expect(storage.deleted).toHaveLength(0);
  }, 30_000);

  it('S2) INFECTED → 409 document_scan_rejected, object purged, NOT downloadable', async () => {
    const storage = new RecordingStorage();
    const svc = makeSvc(
      storage,
      new StubScanProvider({ verdict: 'infected', signature: 'Eicar-Test-Signature' }),
    );
    const { id, thrown } = await createAndFinalize(svc);
    expect(thrown, 'an infected file must reject finalize').toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getStatus()).toBe(409);
    expect(errCode(thrown)).toBe(DOCUMENT_SCAN_REJECTED_CODE);
    // FAIL-CLOSED: the object was purged from storage.
    expect(storage.deleted.length).toBeGreaterThan(0);
    // And the row is archived → a later download is a generic 404 (gone).
    let dlErr: unknown;
    try {
      await svc.getDownloadUrl(manager(), id);
    } catch (e) {
      dlErr = e;
    }
    expect(dlErr).toBeInstanceOf(NotFoundException);
    expect(errCode(dlErr)).toBe('not_found');
  }, 30_000);

  it('S3) SCAN ERROR (engine unreachable) → fail-closed 409 + purge', async () => {
    const storage = new RecordingStorage();
    const svc = makeSvc(
      storage,
      new StubScanProvider({ verdict: 'error', signature: 'engine_unreachable' }),
    );
    const { thrown } = await createAndFinalize(svc);
    expect(thrown, 'an unscannable file must be rejected (fail-closed)').toBeInstanceOf(
      ConflictException,
    );
    expect(errCode(thrown)).toBe(DOCUMENT_SCAN_REJECTED_CODE);
    expect(storage.deleted.length).toBeGreaterThan(0);
  }, 30_000);

  it('S4) scanner THROWS → still fail-closed 409 + purge (never serves)', async () => {
    const storage = new RecordingStorage();
    const svc = makeSvc(storage, new StubScanProvider('throw'));
    const { thrown } = await createAndFinalize(svc);
    expect(thrown).toBeInstanceOf(ConflictException);
    expect(errCode(thrown)).toBe(DOCUMENT_SCAN_REJECTED_CODE);
    expect(storage.deleted.length).toBeGreaterThan(0);
  }, 30_000);
});
