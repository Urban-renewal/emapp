/**
 * R2 factory unit tests — pure (no DB, no network, no AWS SDK).
 *
 * Pins:
 *   1. r2EnvIsComplete returns true iff ALL FOUR env vars are present
 *   2. buildR2Provider constructs the R2StorageProvider with the right
 *      S3Client config (region/endpoint/credentials/forcePathStyle)
 *   3. buildR2Provider throws when env is incomplete (caller contract)
 *   4. The R2StorageProvider it returns wires getSignedUrl + the 5
 *      command constructors correctly (verified via a single PUT-URL
 *      mint that walks the whole stack)
 *
 * The AWS SDK is mocked via plain JS classes — `@emapp/db` does NOT
 * depend on @aws-sdk/*; the SDK lives in the apps that USE it.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { describe, expect, it } from 'vitest';

import { buildR2Provider, r2EnvIsComplete } from '../src/providers/storage/r2-factory';
import { R2StorageProvider } from '../src/providers/storage/r2.provider';

// ── fake SDK shapes (mirror the real @aws-sdk/client-s3 contracts
//    we touch, no more) ───────────────────────────────────────────
class FakeS3Client {
  config: unknown;
  constructor(config: unknown) {
    this.config = config;
  }
  async send(_command?: unknown): Promise<unknown> {
    return {};
  }
}
class FakePutCmd {
  constructor(public opts: { Bucket: string; Key: string }) {}
}
class FakeGetCmd {
  constructor(public opts: { Bucket: string; Key: string }) {}
}
class FakeDelCmd {
  constructor(public opts: { Bucket: string; Key: string }) {}
}
class FakeHeadCmd {
  constructor(public opts: { Bucket: string; Key: string; ChecksumMode?: string }) {}
}
class FakeListCmd {
  constructor(public opts: { Bucket: string; MaxKeys: number }) {}
}

const fakeSdkDeps = {
  S3Client: FakeS3Client,
  // simple deterministic mock — records args + returns synthetic URL
  getSignedUrl: async (
    client: unknown,
    command: unknown,
    opts: { expiresIn: number },
  ): Promise<string> => {
    void client;
    const cmd = command as { opts: { Bucket: string; Key: string } };
    return `https://signed.fake/${cmd.opts.Bucket}/${cmd.opts.Key}?expires=${opts.expiresIn}`;
  },
  PutObjectCommand: FakePutCmd,
  GetObjectCommand: FakeGetCmd,
  DeleteObjectCommand: FakeDelCmd,
  HeadObjectCommand: FakeHeadCmd,
  ListObjectsV2Command: FakeListCmd,
};

const VALID_ENV = {
  R2_ACCESS_KEY_ID: 'AKIA-test-1234567890',
  R2_SECRET_ACCESS_KEY: 'secret-test-abcdefghijklmnopqrstuvwxyz',
  R2_BUCKET: 'emapp-test',
  R2_ENDPOINT: 'https://account-id.eu.r2.cloudflarestorage.com',
};

describe('R2 factory — env presence detector', () => {
  it('1) r2EnvIsComplete true when all 4 vars are present', () => {
    expect(r2EnvIsComplete(VALID_ENV)).toBe(true);
  });

  it('1b) r2EnvIsComplete false when ANY var is missing', () => {
    for (const key of Object.keys(VALID_ENV) as Array<keyof typeof VALID_ENV>) {
      const partial = { ...VALID_ENV, [key]: undefined };
      expect(r2EnvIsComplete(partial), `expected false when ${key} missing`).toBe(false);
    }
  });

  it('1c) r2EnvIsComplete false when ANY var is empty string', () => {
    for (const key of Object.keys(VALID_ENV) as Array<keyof typeof VALID_ENV>) {
      const partial = { ...VALID_ENV, [key]: '' };
      expect(r2EnvIsComplete(partial), `expected false when ${key} empty`).toBe(false);
    }
  });

  it('1d) r2EnvIsComplete false on empty object', () => {
    expect(r2EnvIsComplete({})).toBe(false);
  });
});

describe('R2 factory — buildR2Provider', () => {
  it('2) constructs S3Client with correct R2 config (region=auto + endpoint + creds + forcePathStyle=false + timeouts)', () => {
    const captured: { config?: unknown } = {};
    const deps = {
      ...fakeSdkDeps,
      // override S3Client to capture the config
      S3Client: class extends FakeS3Client {
        constructor(c: unknown) {
          super(c);
          captured.config = c;
        }
      },
    };
    buildR2Provider(VALID_ENV, deps);
    expect(captured.config).toMatchObject({
      region: 'auto',
      endpoint: VALID_ENV.R2_ENDPOINT,
      credentials: {
        accessKeyId: VALID_ENV.R2_ACCESS_KEY_ID,
        secretAccessKey: VALID_ENV.R2_SECRET_ACCESS_KEY,
      },
      forcePathStyle: false,
      // v7 MEDIUM-D: default tunings applied so an R2 outage surfaces
      // fast instead of holding a Fastify worker for the SDK's 30s
      // default socket timeout.
      requestHandler: { connectionTimeout: 3000, socketTimeout: 10_000 },
      maxAttempts: 3,
    });
  });

  it('2c) caller can override default tunings via deps.tuning', () => {
    const captured: { config?: { requestHandler?: unknown; maxAttempts?: number } } = {};
    const deps = {
      ...fakeSdkDeps,
      S3Client: class extends FakeS3Client {
        constructor(c: unknown) {
          super(c);
          captured.config = c as { requestHandler?: unknown; maxAttempts?: number };
        }
      },
      tuning: { connectionTimeoutMs: 500, socketTimeoutMs: 2000, maxAttempts: 1 },
    };
    buildR2Provider(VALID_ENV, deps);
    expect(captured.config?.requestHandler).toEqual({
      connectionTimeout: 500,
      socketTimeout: 2000,
    });
    expect(captured.config?.maxAttempts).toBe(1);
  });

  it('2b) returns an R2StorageProvider instance', () => {
    const p = buildR2Provider(VALID_ENV, fakeSdkDeps);
    expect(p).toBeInstanceOf(R2StorageProvider);
  });

  it('3) throws if env is incomplete (caller contract — guard with r2EnvIsComplete first)', () => {
    expect(() => buildR2Provider({}, fakeSdkDeps)).toThrowError(/incomplete env/);
    expect(() => buildR2Provider({ R2_BUCKET: 'only-this' }, fakeSdkDeps)).toThrowError(
      /incomplete env/,
    );
  });

  it('4) the returned provider wires getSignedUrl + command constructors end-to-end', async () => {
    const p = buildR2Provider(VALID_ENV, fakeSdkDeps);
    const url = await p.getUploadUrl('test/key.xlsx', {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      maxSizeBytes: 1024,
      ttlSeconds: 300,
    });
    // Verify: our FakePutCmd received the Bucket from env, the Key
    // we passed, and the getSignedUrl mock returned a URL containing
    // the bucket+key+ttl — proving the full chain works.
    expect(url).toBe(`https://signed.fake/${VALID_ENV.R2_BUCKET}/test/key.xlsx?expires=300`);
  });

  it('B7) getUploadUrl binds IfNoneMatch:* (create-only) + base64 checksum into the PUT command', async () => {
    // Capture the exact PutObjectCommand opts the provider constructs.
    let captured: Record<string, unknown> | undefined;
    const deps = {
      ...fakeSdkDeps,
      PutObjectCommand: class {
        constructor(public opts: Record<string, unknown>) {
          captured = opts;
        }
      },
    };
    const p = buildR2Provider(VALID_ENV, deps);
    // A 64-char hex sha256 → R2's header wants base64 of the raw digest.
    const hex = 'a'.repeat(64);
    await p.getUploadUrl('org/o/doc/u', {
      contentType: 'application/pdf',
      maxSizeBytes: 2048,
      ttlSeconds: 300,
      createOnly: true,
      contentSha256Hex: hex,
    });
    expect(captured?.['IfNoneMatch'], 'create-only guard must be presigned in').toBe('*');
    expect(
      captured?.['ChecksumSHA256'],
      'the declared hash must be bound as base64 of the raw digest',
    ).toBe(Buffer.from(hex, 'hex').toString('base64'));
  });

  it('B7b) getUploadUrl OMITS the guards when not requested (legacy callers unchanged)', async () => {
    let captured: Record<string, unknown> | undefined;
    const deps = {
      ...fakeSdkDeps,
      PutObjectCommand: class {
        constructor(public opts: Record<string, unknown>) {
          captured = opts;
        }
      },
    };
    const p = buildR2Provider(VALID_ENV, deps);
    await p.getUploadUrl('org/o/doc/u', {
      contentType: 'application/pdf',
      maxSizeBytes: 2048,
      ttlSeconds: 300,
    });
    expect(captured && 'IfNoneMatch' in captured).toBe(false);
    expect(captured && 'ChecksumSHA256' in captured).toBe(false);
  });

  it('B7d) the REAL presigner SIGNS if-none-match + x-amz-checksum-sha256 into the URL (enforcement, not assumption)', async () => {
    // SECURITY-CRITICAL (B7 red-team): asserting the COMMAND carries the opts
    // (B7 above) is INSUFFICIENT — in aws-sdk v3 a request header is only
    // ENFORCED by R2 if it lands in the presigned URL's `X-Amz-SignedHeaders`,
    // which requires the provider to pass `signableHeaders`. This test mints a
    // URL with the REAL @aws-sdk/s3-request-presigner against the REAL
    // PutObjectCommand and inspects the actual query params. If the provider
    // ever drops `signableHeaders`, `X-Amz-SignedHeaders` loses the headers and
    // a leaked URL could overwrite/swap — this fails.
    const provider = new R2StorageProvider(VALID_ENV.R2_BUCKET, {
      // Real S3Client (no network call — presigning is offline/crypto only).
      client: new S3Client({
        region: 'auto',
        endpoint: VALID_ENV.R2_ENDPOINT,
        credentials: {
          accessKeyId: VALID_ENV.R2_ACCESS_KEY_ID,
          secretAccessKey: VALID_ENV.R2_SECRET_ACCESS_KEY,
        },
        forcePathStyle: false,
      }) as unknown as ConstructorParameters<typeof R2StorageProvider>[1]['client'],
      getSignedUrl: getSignedUrl as unknown as ConstructorParameters<
        typeof R2StorageProvider
      >[1]['getSignedUrl'],
      PutObjectCommand: PutObjectCommand as unknown as ConstructorParameters<
        typeof R2StorageProvider
      >[1]['PutObjectCommand'],
      GetObjectCommand: GetObjectCommand as unknown as ConstructorParameters<
        typeof R2StorageProvider
      >[1]['GetObjectCommand'],
      DeleteObjectCommand: DeleteObjectCommand as unknown as ConstructorParameters<
        typeof R2StorageProvider
      >[1]['DeleteObjectCommand'],
      HeadObjectCommand: HeadObjectCommand as unknown as ConstructorParameters<
        typeof R2StorageProvider
      >[1]['HeadObjectCommand'],
      ListObjectsV2Command: ListObjectsV2Command as unknown as ConstructorParameters<
        typeof R2StorageProvider
      >[1]['ListObjectsV2Command'],
    });
    const hex = 'a'.repeat(64);
    const url = await provider.getUploadUrl('org/o/doc/u', {
      contentType: 'application/pdf',
      maxSizeBytes: 2048,
      ttlSeconds: 300,
      createOnly: true,
      contentSha256Hex: hex,
    });
    const signed = new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '';
    const signedSet = new Set(signed.split(';'));
    expect(signedSet.has('if-none-match'), 'create-only header must be SIGNED into the URL').toBe(
      true,
    );
    expect(
      signedSet.has('x-amz-checksum-sha256'),
      'checksum header must be SIGNED into the URL (client MUST send it, R2 enforces it)',
    ).toBe(true);
    // The checksum stays a request header (unhoistable) — it must NOT be hoisted
    // into the query string as `x-amz-checksum-sha256=...`; the client sends it.
    expect(
      new URL(url).searchParams.has('x-amz-checksum-sha256'),
      'checksum must be a signed header the client sends, not hoisted into the query',
    ).toBe(false);
  });

  it('B7e) a legacy PUT (no createOnly / no checksum) does NOT sign those headers', async () => {
    // Backward-compat: callers that mint a plain presigned PUT keep an URL that
    // requires NO extra headers, so existing flows are byte-for-byte unchanged.
    const provider = new R2StorageProvider(VALID_ENV.R2_BUCKET, {
      client: new S3Client({
        region: 'auto',
        endpoint: VALID_ENV.R2_ENDPOINT,
        credentials: {
          accessKeyId: VALID_ENV.R2_ACCESS_KEY_ID,
          secretAccessKey: VALID_ENV.R2_SECRET_ACCESS_KEY,
        },
        forcePathStyle: false,
      }) as unknown as ConstructorParameters<typeof R2StorageProvider>[1]['client'],
      getSignedUrl: getSignedUrl as unknown as ConstructorParameters<
        typeof R2StorageProvider
      >[1]['getSignedUrl'],
      PutObjectCommand: PutObjectCommand as unknown as ConstructorParameters<
        typeof R2StorageProvider
      >[1]['PutObjectCommand'],
      GetObjectCommand: GetObjectCommand as unknown as ConstructorParameters<
        typeof R2StorageProvider
      >[1]['GetObjectCommand'],
      DeleteObjectCommand: DeleteObjectCommand as unknown as ConstructorParameters<
        typeof R2StorageProvider
      >[1]['DeleteObjectCommand'],
      HeadObjectCommand: HeadObjectCommand as unknown as ConstructorParameters<
        typeof R2StorageProvider
      >[1]['HeadObjectCommand'],
      ListObjectsV2Command: ListObjectsV2Command as unknown as ConstructorParameters<
        typeof R2StorageProvider
      >[1]['ListObjectsV2Command'],
    });
    const url = await provider.getUploadUrl('org/o/doc/legacy', {
      contentType: 'application/pdf',
      maxSizeBytes: 2048,
      ttlSeconds: 300,
    });
    const signed = new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '';
    const signedSet = new Set(signed.split(';'));
    expect(signedSet.has('if-none-match')).toBe(false);
    expect(signedSet.has('x-amz-checksum-sha256')).toBe(false);
  });

  it('B7c) head() requests ChecksumMode:ENABLED so R2 returns the stored checksum', async () => {
    // SECURITY-CRITICAL (B7 review): S3/R2 omit `ChecksumSHA256` from a HEAD
    // response UNLESS the request set `ChecksumMode:'ENABLED'`. Without it, the
    // finalize fail-closed gate would read every object as "no checksum" and
    // reject EVERY legitimate upload. Pin that the command carries the flag,
    // and that the provider surfaces the attested checksum.
    let headOpts: { ChecksumMode?: string } | undefined;
    const deps = {
      ...fakeSdkDeps,
      S3Client: class extends FakeS3Client {
        override async send(command?: unknown): Promise<unknown> {
          const cmd = command as { opts?: { ChecksumMode?: string } };
          if (cmd?.opts && 'ChecksumMode' in cmd.opts) headOpts = cmd.opts;
          // Model R2's HEAD response when checksum mode is enabled.
          return { ContentLength: 1234, ChecksumSHA256: 'YmFzZTY0Y2hlY2tzdW0=' };
        }
      },
      HeadObjectCommand: FakeHeadCmd,
    };
    const p = buildR2Provider(VALID_ENV, deps);
    const meta = await p.head('org/o/doc/u');
    expect(headOpts?.ChecksumMode, 'HEAD must request ChecksumMode:ENABLED').toBe('ENABLED');
    expect(meta).toEqual({ contentLength: 1234, checksumSha256: 'YmFzZTY0Y2hlY2tzdW0=' });
  });
});
