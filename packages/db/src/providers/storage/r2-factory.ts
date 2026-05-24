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
   *  `client.send(...)` which we narrow via S3ClientLike.
   *  `requestHandler` + `maxAttempts` are passed through verbatim —
   *  the SDK's @smithy/node-http-handler accepts the shape we expose
   *  via `R2ClientTuning` below. Kept untyped here so @emapp/db
   *  doesn't depend on @smithy/* either. */
  readonly S3Client: new (config: {
    region: string;
    endpoint: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
    forcePathStyle?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requestHandler?: any;
    maxAttempts?: number;
  }) => S3ClientLike;
  /** Async presigned-URL signer (`@aws-sdk/s3-request-presigner`).
   *  Loose-typed because the SDK's real signature is heavily generic
   *  (typed Command<Input, Output> chains) and we'd have to depend on
   *  @aws-sdk/* to express it precisely — which we deliberately don't.
   *  R2StorageProvider only consumes the Promise<string> return; the
   *  call site (api / worker factory) passes the real SDK function. */
  readonly getSignedUrl: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  /** Optional client tuning. If omitted, the SDK's defaults apply
   *  (30s socket timeout, infinite connection timeout, 3 attempts).
   *  Apps MUST pass narrow values in production — `getUploadUrl` /
   *  `head` are on the request critical path; a hanging R2 connect
   *  must surface as 503 fast, not hold a Fastify worker for 30s.
   *  v7 audit Agent C MEDIUM-D. */
  readonly tuning?: R2ClientTuning;
}

/** Narrow tuning shape so call sites don't depend on @smithy/*.
 *  The SDK's S3Client accepts `requestHandler` as a plain
 *  `NodeHttpHandlerOptions` object literal — it will build the
 *  NodeHttpHandler internally with these values, so we don't need
 *  to import or instantiate one ourselves. */
export interface R2ClientTuning {
  /** Max ms to wait for TCP+TLS handshake. Default: 3000.
   *  R2's eu region is sub-100ms from EU CI runners; if a connect
   *  hasn't completed in 3s, something is broken — fail fast. */
  readonly connectionTimeoutMs?: number;
  /** Max ms a socket can be idle waiting for bytes. Default: 10000.
   *  For streaming GETs the socket sees chunks regularly so the
   *  idle clock resets per chunk; 10s is the gap BETWEEN chunks. */
  readonly socketTimeoutMs?: number;
  /** Total request attempts including the first. Default: 3 (one
   *  initial + two retries on retryable errors). */
  readonly maxAttempts?: number;
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
  //
  // v7 audit Agent C MEDIUM-D: bound the SDK's default 30s socket
  // timeout. R2 outages should surface as 503 within seconds, not hold
  // a Fastify worker for 30s.
  const tuning = deps.tuning ?? {};
  const connectionTimeout = tuning.connectionTimeoutMs ?? 3_000;
  const socketTimeout = tuning.socketTimeoutMs ?? 10_000;
  const maxAttempts = tuning.maxAttempts ?? 3;
  // The SDK accepts `requestHandler` as either a constructed handler
  // OR a plain options object — when it's an object literal the SDK
  // builds a NodeHttpHandler internally with those values. Passing the
  // literal lets us tune timeouts without depending on @smithy/* here.
  const client = new deps.S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: false,
    requestHandler: { connectionTimeout, socketTimeout },
    maxAttempts,
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
