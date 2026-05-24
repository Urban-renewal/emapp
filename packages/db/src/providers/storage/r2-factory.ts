/**
 * R2StorageProvider builder — single source of truth for the AWS SDK
 * wiring that turns the 4 R2_* env vars into a configured provider.
 *
 * Why here (in @emapp/db, not per-app):
 *   - Both apps/api AND apps/worker need to construct the same provider
 *     from the same env vars. Without this helper, each factory would
 *     duplicate the S3Client + getSignedUrl wiring — exactly the drift
 *     risk v6 §2c addressed for fingerprintHeaders.
 *   - @emapp/db already owns the IStorageProvider interface + the
 *     R2StorageProvider class; collocating the constructor wiring keeps
 *     the AWS SDK contact surface in ONE module.
 *
 * Why NOT a hard dep:
 *   - @emapp/db does NOT depend on @aws-sdk/* packages — apps inject
 *     them via the `deps` arg below. This keeps @emapp/db's transitive
 *     graph slim (test packages don't pull AWS), and lets each app
 *     choose its own SDK version if they ever need to.
 *
 * Caller contract:
 *   - Pass env vars + AWS SDK constructors/functions in `deps`.
 *   - Returns a ready-to-use IStorageProvider.
 *   - Throws if any env var is missing — callers MUST validate first
 *     (the env validator marks R2_* optional; both factories check
 *     presence + decide whether to call here vs fall back to Fake).
 */
import { R2StorageProvider } from './r2.provider';
import type { IStorageProvider } from './storage.interface';

/** Structural shape of the S3 client we need — kept narrow so
 *  @emapp/db doesn't take a direct dep on @aws-sdk/client-s3. Apps
 *  pass the real SDK constructor in `deps`; the SDK only lives in
 *  the apps that USE it (api + worker). */
interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface R2EnvVars {
  readonly R2_ACCESS_KEY_ID?: string;
  readonly R2_SECRET_ACCESS_KEY?: string;
  readonly R2_BUCKET?: string;
  readonly R2_ENDPOINT?: string;
}

export interface R2SdkDeps {
  /** Constructor for the S3 client itself. Apps pass the real
   *  @aws-sdk/client-s3 S3Client constructor; we accept `unknown`
   *  for the instance shape because R2StorageProvider only uses
   *  `client.send(...)` which we narrow via S3ClientLike. */
  readonly S3Client: new (config: {
    region: string;
    endpoint: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
    forcePathStyle?: boolean;
  }) => S3ClientLike;
  /** Async presigned-URL signer (`@aws-sdk/s3-request-presigner`).
   *  Loose-typed because the SDK's real signature is heavily generic
   *  (typed Command<Input, Output> chains) and we'd have to depend on
   *  @aws-sdk/* to express it precisely — which we deliberately don't.
   *  R2StorageProvider only consumes the Promise<string> return; the
   *  call site (api / worker factory) passes the real SDK function. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly getSignedUrl: (
    client: any,
    command: any,
    opts: { expiresIn: number },
  ) => Promise<string>;
  /** Command constructors used by R2StorageProvider. */
  readonly PutObjectCommand: new (opts: {
    Bucket: string;
    Key: string;
    ContentType: string;
    ContentLength: number;
  }) => unknown;
  readonly GetObjectCommand: new (opts: {
    Bucket: string;
    Key: string;
    ResponseContentDisposition?: string;
  }) => unknown;
  readonly DeleteObjectCommand: new (opts: { Bucket: string; Key: string }) => unknown;
  readonly HeadObjectCommand: new (opts: { Bucket: string; Key: string }) => unknown;
  readonly ListObjectsV2Command: new (opts: { Bucket: string; MaxKeys: number }) => unknown;
}

/** True iff all four R2_* env vars are populated (non-empty strings).
 *  Callers use this BEFORE calling buildR2Provider to decide whether
 *  R2 is the right choice vs falling back to Fake/Fail. */
export function r2EnvIsComplete(env: R2EnvVars): env is Required<R2EnvVars> {
  return Boolean(
    env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_ENDPOINT,
  );
}

/** Build a configured R2StorageProvider. Throws if env vars are
 *  incomplete (caller MUST guard with `r2EnvIsComplete` first). */
export function buildR2Provider(env: R2EnvVars, deps: R2SdkDeps): IStorageProvider {
  if (!r2EnvIsComplete(env)) {
    throw new Error(
      'buildR2Provider called with incomplete env (need ' +
        'R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY + R2_BUCKET + R2_ENDPOINT). ' +
        'Use r2EnvIsComplete() before calling.',
    );
  }
  // R2 ignores region but the SDK requires it. `forcePathStyle:false` is
  // correct for R2 — the endpoint already encodes the account-id (the
  // bucket appears as a subdomain).
  const client = new deps.S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: false,
  });
  return new R2StorageProvider(env.R2_BUCKET, {
    client,
    getSignedUrl: deps.getSignedUrl,
    PutObjectCommand: deps.PutObjectCommand,
    GetObjectCommand: deps.GetObjectCommand,
    DeleteObjectCommand: deps.DeleteObjectCommand,
    HeadObjectCommand: deps.HeadObjectCommand,
    ListObjectsV2Command: deps.ListObjectsV2Command,
  });
}
