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

  async getUploadUrl(key: string, opts: UploadUrlOptions): Promise<string> {
    this.uploaded.push({ key, opts });
    return `https://fake-storage.test/upload/${key}?contentType=${opts.contentType}`;
  }

  async getDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string> {
    this.downloaded.push({ key, opts });
    return `https://fake-storage.test/download/${key}`;
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
  }

  /** D.28 R2 interface prep: Fake doesn't store real bytes, so it cannot
   *  attest object metadata — returns null. Callers (e.g.
   *  DocumentsService.finalize) treat null as "no storage attestation"
   *  and fall back to the existing client-consistency check. When R2
   *  lands, the real provider will return actual contentLength + checksum
   *  and the same call site gains true tamper-evidence with no code
   *  change. */
  async head(_key: string): Promise<StorageObjectMeta | null> {
    return null;
  }

  async healthCheck(): Promise<void> {}

  reset(): void {
    this.uploaded = [];
    this.downloaded = [];
    this.deleted = [];
  }
}
