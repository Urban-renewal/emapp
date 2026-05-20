export interface UploadUrlOptions {
  contentType: string;
  maxSizeBytes: number;
  ttlSeconds: number;
}

export interface DownloadUrlOptions {
  ttlSeconds: number;
  responseFilename?: string;
}

/** Object metadata returned by IStorageProvider.head().
 *
 * D.28 R1/R2 (audit-pass V #4 — interface prep, 2026-05-20): the finalize
 * integrity gate today compares CLIENT-declared create vs CLIENT-declared
 * finalize values — only catches an inconsistent client. The fix is to
 * call `head()` after upload and compare the STORAGE-attested size +
 * checksum against the create-declared values. FakeStorageProvider
 * returns `null` (no real bytes stored) → the service falls back to the
 * existing client-consistency check. R2 will return real values → the
 * finalize gate becomes true tamper-evidence. Same code path either way. */
export interface StorageObjectMeta {
  contentLength: number;
  /** Hex sha256 if the storage provider can attest it (R2 supports it
   *  via `x-amz-checksum-sha256`). Omitted when the provider can't
   *  attest. */
  checksumSha256?: string;
}

export interface IStorageProvider {
  getUploadUrl(key: string, opts: UploadUrlOptions): Promise<string>;
  getDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string>;
  delete(key: string): Promise<void>;
  /** Return object metadata, or `null` if the object isn't yet present
   *  / the provider can't attest. Callers MUST treat null as "no
   *  storage-attested fact" and fall back to the client-consistency
   *  check (not as an integrity pass). */
  head(key: string): Promise<StorageObjectMeta | null>;
  healthCheck(): Promise<void>;
}
