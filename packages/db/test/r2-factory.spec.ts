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
  async send(): Promise<unknown> {
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
  constructor(public opts: { Bucket: string; Key: string }) {}
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
  it('2) constructs S3Client with correct R2 config (region=auto + endpoint + creds + forcePathStyle=false)', () => {
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
    });
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
});
