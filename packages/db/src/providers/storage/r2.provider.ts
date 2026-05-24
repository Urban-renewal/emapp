import { Readable } from 'node:stream';

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
  /** Second arg is the AWS SDK's optional `HttpHandlerOptions` (we
   *  use it only for `{ abortSignal }` v8 SOLID-6). Kept loose to
   *  avoid pulling in @smithy/* types — the real SDK accepts any
   *  shape compatible with this. */
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
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

  /** Phase 6 worker: stream the object bytes for ExcelJS streaming
   *  parse. The S3 SDK v3 GetObjectCommand returns `{ Body }` which in
   *  Node is a Readable. Caller MUST consume or destroy the stream
   *  (otherwise we leak an open R2 connection from the pool). */
  async getObjectStream(key: string): Promise<Readable> {
    const cmd = new this.deps.GetObjectCommand({ Bucket: this.bucket, Key: key });
    const res = (await this.deps.client.send(cmd)) as { Body?: unknown };
    const body = res?.Body;
    if (!body || typeof (body as Readable).pipe !== 'function') {
      throw new Error(`R2: GetObject for ${key} returned no streamable body`);
    }
    return body as Readable;
  }

  /** D.28 R1/R2: storage-attested object metadata. Returns:
   *   - `{ contentLength, checksumSha256? }` when the object exists.
   *   - `null` when the object is absent (404 / NotFound / NoSuchKey).
   *  Any other failure (network, auth, 5xx) RETHROWS — those are infra
   *  problems the caller should surface, not silently treat as "no
   *  attestation". (Treating a 500 as null would let a tampered upload
   *  pass the finalize integrity gate during an R2 outage.) */
  async head(key: string, opts?: { signal?: AbortSignal }): Promise<StorageObjectMeta | null> {
    try {
      // AWS SDK v3 client.send() accepts `{ abortSignal }` to plumb
      // an AbortController through to the underlying request — the
      // socket is torn down when the signal fires. v8 SOLID-6.
      const sendOpts = opts?.signal ? { abortSignal: opts.signal } : undefined;
      const res = (await this.deps.client.send(
        new this.deps.HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        sendOpts,
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
