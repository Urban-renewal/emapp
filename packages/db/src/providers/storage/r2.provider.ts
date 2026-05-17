import type { IStorageProvider, UploadUrlOptions, DownloadUrlOptions } from './storage.interface';

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
  ListObjectsV2Command: new (opts: { Bucket: string; MaxKeys: number }) => unknown;
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

  async healthCheck(): Promise<void> {
    await this.deps.client.send(
      new this.deps.ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }),
    );
  }
}
