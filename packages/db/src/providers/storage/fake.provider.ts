import { Readable } from 'node:stream';

import type {
  IStorageProvider,
  UploadUrlOptions,
  DownloadUrlOptions,
  StorageObjectMeta,
} from './storage.interface';

/** Construction options for {@link FakeStorageProvider}. */
export interface FakeStorageProviderOptions {
  /**
   * When `true`, `getUploadUrl`/`getDownloadUrl` THROW an actionable
   * "storage not configured" error instead of returning a
   * `https://fake-storage.test/…` URL that 404s downstream with no clue.
   *
   * This is the DEV-fallback safety flag: the API factory passes it ONLY
   * in the dev branch (R2 incomplete AND not production AND not test), so
   * a developer who forgot to set the R2_* secrets gets a clear error at
   * the document upload/download/preview call site — instead of a
   * mysterious 404 on a non-existent host.
   *
   * It MUST stay `false` (the default) for the in-memory test fakes: under
   * `NODE_ENV==='test'` the storage/worker specs rely on the URL-minting +
   * in-memory `objects` behaviour being unchanged. The in-memory
   * `setObject`/`getObjectStream`/`head`/`delete` paths are NEVER affected
   * by this flag — only the two URL-minting methods.
   */
  readonly failUrlsOutsideTest?: boolean;
}

/** Thrown by {@link FakeStorageProvider.getUploadUrl}/`getDownloadUrl`
 *  when the provider was constructed with `failUrlsOutsideTest: true`
 *  (dev with R2 unconfigured). Names no secrets — just the remedy. */
export const STORAGE_NOT_CONFIGURED_MESSAGE =
  'object storage is not configured — set R2_* in Infisical (see boot warning)';

export class FakeStorageProvider implements IStorageProvider {
  public uploaded: Array<{ key: string; opts: UploadUrlOptions }> = [];
  public downloaded: Array<{ key: string; opts: DownloadUrlOptions }> = [];
  public deleted: string[] = [];
  /** In-memory object bytes. Phase 6 tests put a real Excel buffer here
   *  before invoking the parser. Production code never reaches this — the
   *  factory FAILS FAST in prod (D.28 governed pattern). */
  public readonly objects: Map<string, Buffer> = new Map();

  /** See {@link FakeStorageProviderOptions.failUrlsOutsideTest}. Default
   *  `false` so every existing test construction is byte-for-byte
   *  unchanged. */
  private readonly failUrlsOutsideTest: boolean;

  constructor(options: FakeStorageProviderOptions = {}) {
    this.failUrlsOutsideTest = options.failUrlsOutsideTest ?? false;
  }

  async getUploadUrl(key: string, opts: UploadUrlOptions): Promise<string> {
    if (this.failUrlsOutsideTest) throw new Error(STORAGE_NOT_CONFIGURED_MESSAGE);
    this.uploaded.push({ key, opts });
    return `https://fake-storage.test/upload/${key}?contentType=${opts.contentType}`;
  }

  async getDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string> {
    if (this.failUrlsOutsideTest) throw new Error(STORAGE_NOT_CONFIGURED_MESSAGE);
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
