/**
 * SECURITY-UPLOAD-AUDIT.md threat #3 — magic-byte (real-content-type)
 * verification on the documents path (real-DB, service-level smoke).
 *
 * The change under test: the documents pipeline now sniffs the REAL leading
 * bytes of the uploaded object and verifies they are consistent with the
 * declared `mimeType` BEFORE the AV scan / store. A spoof (e.g. PNG or ZIP
 * bytes declared as `application/pdf`) is rejected FAIL-CLOSED with 409
 * `document_type_mismatch` and the same archive+purge posture as an infected
 * file — never stored, never servable. Mirrors the import path's ZIP magic
 * check (`apps/worker/src/parser/zip-preflight.ts`) and the scan-gate spec.
 *
 * Pins (each LOAD-BEARING):
 *  M1  real PDF bytes + declared application/pdf → finalize ok, downloadable
 *      (the gate does not over-block legitimate files).
 *  M2  PNG bytes declared application/pdf → finalize throws 409
 *      document_type_mismatch, object purged, NOT downloadable.
 *  M3  ZIP bytes declared application/pdf → same 409 + purge (a docx/xlsx
 *      polyglot can't masquerade as a PDF).
 *  M4  text/plain (un-verifiable: no magic) → passes regardless of bytes
 *      (we don't manufacture false positives on legitimate text).
 *  M5  the unit verifier accepts OOXML (ZIP magic) declared as docx and
 *      rejects a PDF declared as docx.
 */
import { Readable } from 'node:stream';

import { NoopFileScanProvider, type IFileScanProvider, type IStorageProvider } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { DocumentsService } from './documents.service';
import { verifyMagicBytes } from './magic-bytes';

const PUT_URL = 'https://r2.example.test/presigned-put';
const GET_URL = 'https://r2.example.test/presigned-get';

// Representative leading bytes for the families under test.
const PDF_BYTES = Buffer.from('%PDF-1.4\n%âãÏÓ\nrest of a small pdf', 'latin1');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const TEXT_BYTES = Buffer.from('just,some,plain,csv,text\n1,2,3,4,5\n', 'utf8');

/** Stub storage: serves a CONFIGURABLE byte payload for the scanner's lazy
 *  loader (so M1/M2/M3 control the "real" object bytes) and records delete()
 *  so the purge-on-reject assertion is exact. */
class RecordingStorage implements IStorageProvider {
  public readonly deleted: string[] = [];
  constructor(private readonly payload: Buffer) {}
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
  async putObject(): Promise<void> {}
  async getObjectStream(): Promise<Readable> {
    return Readable.from([this.payload]);
  }
  async healthCheck(): Promise<void> {}
}

let org: TestOrg;
let managerId: string;
let projectId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000d1';

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

/** create → finalize a non-sensitive doc with the given declared MIME; the
 *  storage stub serves `payload` as the "real" object bytes. */
async function createAndFinalize(
  svc: DocumentsService,
  declaredMime: string,
): Promise<{ id: string; thrown?: unknown }> {
  const created = await svc.create(manager(), {
    name: 'file.bin',
    type: 'other',
    mimeType: declaredMime as never,
    sizeBytes: 100,
    contentHash: 'h-magic',
    projectId,
  });
  const id = created.document.id;
  try {
    await svc.finalize(manager(), id, { sizeBytes: 100, contentHash: 'h-magic' });
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
  const tag = `magic-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('magic-bytes — unit verifier', () => {
  it('M5a) accepts a real PDF declared application/pdf', () => {
    expect(verifyMagicBytes(PDF_BYTES, 'application/pdf').ok).toBe(true);
  });
  it('M5b) rejects PNG bytes declared application/pdf', () => {
    expect(verifyMagicBytes(PNG_BYTES, 'application/pdf').ok).toBe(false);
  });
  it('M5c) rejects ZIP bytes declared application/pdf', () => {
    expect(verifyMagicBytes(ZIP_BYTES, 'application/pdf').ok).toBe(false);
  });
  it('M5d) accepts ZIP (OOXML) bytes declared as docx', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(verifyMagicBytes(ZIP_BYTES, docx).ok).toBe(true);
  });
  it('M5e) rejects PDF bytes declared as docx', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(verifyMagicBytes(PDF_BYTES, docx).ok).toBe(false);
  });
  it('M5f) passes un-verifiable text/plain + text/csv regardless of bytes', () => {
    expect(verifyMagicBytes(PNG_BYTES, 'text/plain').ok).toBe(true);
    expect(verifyMagicBytes(PNG_BYTES, 'text/csv').ok).toBe(true);
  });
  it('M5g) accepts PNG declared image/png', () => {
    expect(verifyMagicBytes(PNG_BYTES, 'image/png').ok).toBe(true);
  });
});

describe('magic-bytes — finalize/scan pipeline (real-DB)', () => {
  it('M1) real PDF + declared application/pdf → finalize ok + downloadable', async () => {
    const storage = new RecordingStorage(PDF_BYTES);
    const svc = makeSvc(storage, new NoopFileScanProvider());
    const { id, thrown } = await createAndFinalize(svc, 'application/pdf');
    expect(thrown, 'a matching file must finalize without throwing').toBeUndefined();
    const dl = await svc.getDownloadUrl(manager(), id);
    expect(dl.url).toBe(GET_URL);
    expect(storage.deleted).toHaveLength(0);
  }, 30_000);

  it('M2) PNG bytes declared application/pdf → 409 document_type_mismatch + purged', async () => {
    const storage = new RecordingStorage(PNG_BYTES);
    const svc = makeSvc(storage, new NoopFileScanProvider());
    const { thrown } = await createAndFinalize(svc, 'application/pdf');
    expect(errCode(thrown)).toBe('document_type_mismatch');
    // FAIL-CLOSED: the spoofed object was purged from storage.
    expect(storage.deleted.length).toBeGreaterThan(0);
  }, 30_000);

  it('M3) ZIP bytes declared application/pdf → 409 document_type_mismatch + purged', async () => {
    const storage = new RecordingStorage(ZIP_BYTES);
    const svc = makeSvc(storage, new NoopFileScanProvider());
    const { thrown } = await createAndFinalize(svc, 'application/pdf');
    expect(errCode(thrown)).toBe('document_type_mismatch');
    expect(storage.deleted.length).toBeGreaterThan(0);
  }, 30_000);

  it('M4) text/csv (un-verifiable) passes even with non-text bytes', async () => {
    const storage = new RecordingStorage(TEXT_BYTES);
    const svc = makeSvc(storage, new NoopFileScanProvider());
    const { thrown } = await createAndFinalize(svc, 'text/csv');
    expect(thrown, 'text has no magic — must not be spoof-rejected').toBeUndefined();
    expect(storage.deleted).toHaveLength(0);
  }, 30_000);
});
