import { Readable } from 'node:stream';

import type {
  IStorageProvider,
  UploadUrlOptions,
  DownloadUrlOptions,
  StorageObjectMeta,
} from './storage.interface';

export class FakeStorageProvider implements IStorageProvider {
  public uploaded: Array<{ key: string; opts: UploadUrlOptions }> = [];
  public downloaded: Array<{ key: string; opts: DownloadUrlOptions }> = [];
  public deleted: string[] = [];
  /** In-memory object bytes. Phase 6 tests put a real Excel buffer here
   *  before invoking the parser. Production code never reaches this — the
   *  factory FAILS FAST in prod (D.28 governed pattern). */
  public readonly objects: Map<string, Buffer> = new Map();

  async getUploadUrl(key: string, opts: UploadUrlOptions): Promise<string> {
    this.uploaded.push({ key, opts });
    return `https://fake-storage.test/upload/${key}?contentType=${opts.contentType}`;
  }

  async getDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string> {
    this.downloaded.push({ key, opts });
    return `https://fake-storage.test/download/${key}`;
  }

  /** Test-only helper to seed object bytes. NOT part of IStorageProvider
   *  — tests cast to FakeStorageProvider to call this. */
  setObject(key: string, body: Buffer): void {
    this.objects.set(key, body);
  }

  async getObjectStream(key: string): Promise<Readable> {
    const buf = this.objects.get(key);
    if (!buf) throw new Error(`FakeStorageProvider: no object for key ${key}`);
    return Readable.from(buf);
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }

  /** D.28 R2 interface prep: Fake doesn't store real bytes, so it cannot
   *  attest object metadata — returns null. Callers (e.g.
   *  DocumentsService.finalize) treat null as "no storage attestation"
   *  and fall back to the existing client-consistency check. When R2
   *  lands, the real provider will return actual contentLength + checksum
   *  and the same call site gains true tamper-evidence with no code
   *  change. */
  async head(_key: string, _opts?: { signal?: AbortSignal }): Promise<StorageObjectMeta | null> {
    // Fake doesn't make a network call so it can't be "aborted" in
    // any meaningful way; we still accept the optional signal so the
    // interface is unified with R2StorageProvider.head().
    return null;
  }

  async healthCheck(): Promise<void> {}

  reset(): void {
    this.uploaded = [];
    this.downloaded = [];
    this.deleted = [];
    this.objects.clear();
  }
}
