import type {
  IStorageProvider,
  UploadUrlOptions,
  DownloadUrlOptions,
  StorageObjectMeta,
} from './storage.interface';

/** R2/S3 SDK error shape — we only care about the `name` discriminator
 *  (`NotFound` / `NoSuchKey`) so we can map a missing object to `null`
 *  rather than a thrown exception. */
interface S3LikeError {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

interface SignedUrlFn {
  (client: S3ClientLike, command: unknown, opts: { expiresIn: number }): Promise<string>;
}

interface R2Deps {
  client: S3ClientLike;
  getSignedUrl: SignedUrlFn;
  PutObjectCommand: new (opts: {
    Bucket: string;
    Key: string;
    ContentType: string;
    ContentLength: number;
  }) => unknown;
  GetObjectCommand: new (opts: {
    Bucket: string;
    Key: string;
    ResponseContentDisposition?: string;
  }) => unknown;
  DeleteObjectCommand: new (opts: { Bucket: string; Key: string }) => unknown;
  HeadObjectCommand: new (opts: { Bucket: string; Key: string }) => unknown;
  ListObjectsV2Command: new (opts: { Bucket: string; MaxKeys: number }) => unknown;
}

/** Shape S3/R2's `HeadObject` response actually carries. We type just
 * the bits we read so the rest of the SDK shape is unconstrained. */
interface HeadObjectResponse {
  ContentLength?: number;
  ChecksumSHA256?: string; // R2 attests this when uploaded with checksum
}

export class R2StorageProvider implements IStorageProvider {
  private readonly bucket: string;
  private readonly deps: R2Deps;

  constructor(bucket: string, deps: R2Deps) {
    this.bucket = bucket;
    this.deps = deps;
  }

  async getUploadUrl(key: string, opts: UploadUrlOptions): Promise<string> {
    const cmd = new this.deps.PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.maxSizeBytes,
    });
    return this.deps.getSignedUrl(this.deps.client, cmd, { expiresIn: opts.ttlSeconds });
  }

  async getDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string> {
    const cmd = new this.deps.GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: opts.responseFilename
        ? `attachment; filename="${opts.responseFilename}"`
        : undefined,
    });
    return this.deps.getSignedUrl(this.deps.client, cmd, { expiresIn: opts.ttlSeconds });
  }

  async delete(key: string): Promise<void> {
    await this.deps.client.send(
      new this.deps.DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /** D.28 R1/R2: storage-attested object metadata. Returns:
   *   - `{ contentLength, checksumSha256? }` when the object exists.
   *   - `null` when the object is absent (404 / NotFound / NoSuchKey).
   *  Any other failure (network, auth, 5xx) RETHROWS — those are infra
   *  problems the caller should surface, not silently treat as "no
   *  attestation". (Treating a 500 as null would let a tampered upload
   *  pass the finalize integrity gate during an R2 outage.) */
  async head(key: string): Promise<StorageObjectMeta | null> {
    try {
      const res = (await this.deps.client.send(
        new this.deps.HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as HeadObjectResponse;
      if (typeof res?.ContentLength !== 'number') return null;
      return {
        contentLength: res.ContentLength,
        ...(typeof res.ChecksumSHA256 === 'string' ? { checksumSha256: res.ChecksumSHA256 } : {}),
      };
    } catch (e) {
      const err = e as S3LikeError;
      const status = err?.$metadata?.httpStatusCode;
      const name = err?.name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
        return null;
      }
      throw e;
    }
  }

  async healthCheck(): Promise<void> {
    await this.deps.client.send(
      new this.deps.ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }),
    );
  }
}
