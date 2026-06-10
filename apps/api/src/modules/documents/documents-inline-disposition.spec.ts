/**
 * S2 invites+docs · #1 — inline document VIEW (Content-Disposition).
 *
 * INDEPENDENT acceptance test (test-author did NOT write the impl).
 *
 * SPEC under test:
 *  GET /api/v1/documents/:id/download?disposition=inline for a CLEAN doc must
 *  mint a presigned URL whose Content-Disposition is `inline` (renders in the
 *  browser). The default (no param) and explicit `attachment` must mint an
 *  `attachment` disposition (forces download). An infected/unscanned doc is
 *  STILL gated (no URL minted, 409 scan-rejected) for BOTH dispositions — the
 *  inline option must not become a fail-open bypass of the malware gate.
 *
 * The contract type already exists (`DocumentDispositionEnum`,
 * `DownloadDocumentQuery` in @emapp/shared-types). The GAP this RED test
 * proves is in the SERVICE/STORAGE wiring: `getDownloadUrl` does not yet accept
 * a disposition and never threads it into the storage `DownloadUrlOptions`, so
 * a caller asking for `inline` still gets `attachment` (or the option is
 * dropped entirely).
 *
 * Assertion level mirrors the existing document-download specs
 * (documents-scan-gate.spec.ts / documents-ghost-doc.spec.ts): a recording
 * IStorageProvider captures every getDownloadUrl(key, opts) call, and we
 * inspect the disposition the service asked the provider to stamp. Service
 * level (not HTTP) — deterministic, sidesteps the signup throttler.
 *
 * Seeding follows documents-ghost-doc.spec.ts: createTestOrg + a raw
 * providerPool INSERT. A row with uploaded_at + scan_status='clean' is
 * downloadable; scan_status='infected'/'pending' is gated.
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  NoopFileScanProvider,
  type DownloadUrlOptions,
  type IStorageProvider,
  type StorageObjectMeta,
} from '@emapp/db';
import { DOCUMENT_SCAN_REJECTED_CODE } from '@emapp/shared-types';
import { ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { DocumentsService } from './documents.service';

const GET_URL = 'https://r2.example.test/presigned-get';

/**
 * Recording storage: captures every getDownloadUrl(key, opts) so the test can
 * inspect the Content-Disposition the SERVICE asked the provider to stamp.
 *
 * `opts` is typed loosely (DownloadUrlOptions & { disposition?: string }) so
 * the test compiles BEFORE the builder adds the `disposition` field to
 * DownloadUrlOptions — the RED assertion reads `opts.disposition` which is
 * `undefined` until the wiring lands.
 */
type CapturedOpts = DownloadUrlOptions & { disposition?: string };
class RecordingStorage implements IStorageProvider {
  public readonly downloads: Array<{ key: string; opts: CapturedOpts }> = [];
  async getUploadUrl(): Promise<string> {
    return 'https://r2.example.test/presigned-put';
  }
  async getDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string> {
    this.downloads.push({ key, opts: opts as CapturedOpts });
    return GET_URL;
  }
  async head(): Promise<StorageObjectMeta | null> {
    return null;
  }
  async delete(): Promise<void> {}
  async getObjectStream(): Promise<Readable> {
    return Readable.from([Buffer.from('%PDF-1.4 fake bytes')]);
  }
  async healthCheck(): Promise<void> {}

  /** The disposition the service asked the provider to stamp on the LAST
   *  download (the only call this suite makes per case). */
  lastDisposition(): string | undefined {
    return this.downloads[this.downloads.length - 1]?.opts.disposition;
  }
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

function makeSvc(storage: IStorageProvider): DocumentsService {
  return new DocumentsService(
    storage,
    new NoopFileScanProvider(),
    new NotificationsProducerService(),
  );
}

/** Seed a finalised documents row (uploaded_at set) with a chosen scan_status.
 *  Inserted via providerPool (BYPASSRLS), mirroring documents-ghost-doc.spec. */
async function seedDoc(scanStatus: 'clean' | 'infected' | 'pending'): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at, scan_status)
       VALUES ($1, $2, 'plan.pdf', 'other', 'application/pdf', 100, $3, 'h', $4, $5, $6)
       RETURNING id`,
      [org.id, projectId, `org/${org.id}/doc/${randomUUID()}`, managerId, new Date(), scanStatus],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
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

/** Invoke getDownloadUrl with an optional disposition. Cast so the test
 *  compiles before getDownloadUrl's signature gains the 2nd arg. */
async function download(
  svc: DocumentsService,
  user: AccessTokenPayload,
  id: string,
  disposition?: 'inline' | 'attachment',
): Promise<{ url: string }> {
  const fn = (
    svc as unknown as {
      getDownloadUrl: (u: AccessTokenPayload, id: string, d?: string) => Promise<{ url: string }>;
    }
  ).getDownloadUrl.bind(svc);
  return disposition === undefined ? fn(user, id) : fn(user, id, disposition);
}

beforeAll(async () => {
  await setupTestDatabase();
  const tag = `inline-disp-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('#1 inline document view — Content-Disposition (real-DB, service-level)', () => {
  it('I1) disposition=inline on a CLEAN doc → presigned URL stamped inline', async () => {
    const storage = new RecordingStorage();
    const svc = makeSvc(storage);
    const id = await seedDoc('clean');

    const res = await download(svc, manager(), id, 'inline');
    expect(res.url).toBe(GET_URL);
    expect(storage.downloads.length, 'a download URL must have been minted').toBe(1);
    expect(
      storage.lastDisposition(),
      'inline request must stamp Content-Disposition: inline (renders in-browser)',
    ).toBe('inline');
  }, 30_000);

  it('I2) default (no param) on a CLEAN doc → presigned URL stamped attachment', async () => {
    const storage = new RecordingStorage();
    const svc = makeSvc(storage);
    const id = await seedDoc('clean');

    const res = await download(svc, manager(), id /* no disposition */);
    expect(res.url).toBe(GET_URL);
    expect(storage.downloads.length).toBe(1);
    expect(storage.lastDisposition(), 'default must force download (attachment)').toBe(
      'attachment',
    );
  }, 30_000);

  it('I3) disposition=attachment on a CLEAN doc → presigned URL stamped attachment', async () => {
    const storage = new RecordingStorage();
    const svc = makeSvc(storage);
    const id = await seedDoc('clean');

    await download(svc, manager(), id, 'attachment');
    expect(storage.lastDisposition()).toBe('attachment');
  }, 30_000);

  it('I4) INFECTED doc → gated for BOTH dispositions (no URL, 409 scan-rejected)', async () => {
    const storage = new RecordingStorage();
    const svc = makeSvc(storage);
    const id = await seedDoc('infected');

    for (const disp of ['inline', 'attachment'] as const) {
      let thrown: unknown;
      try {
        await download(svc, manager(), id, disp);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `infected doc must be gated for disposition=${disp}`).toBeInstanceOf(
        ConflictException,
      );
      expect(errCode(thrown)).toBe(DOCUMENT_SCAN_REJECTED_CODE);
    }
    // FAIL-CLOSED: the gate fires BEFORE any presign — no URL ever minted.
    expect(storage.downloads.length, 'infected doc must never reach the presign').toBe(0);
  }, 30_000);

  it('I5) UNSCANNED (pending) doc → gated for inline too (inline is not a fail-open bypass)', async () => {
    const storage = new RecordingStorage();
    const svc = makeSvc(storage);
    const id = await seedDoc('pending');

    let thrown: unknown;
    try {
      await download(svc, manager(), id, 'inline');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect(errCode(thrown)).toBe(DOCUMENT_SCAN_REJECTED_CODE);
    expect(storage.downloads.length).toBe(0);
  }, 30_000);
});
