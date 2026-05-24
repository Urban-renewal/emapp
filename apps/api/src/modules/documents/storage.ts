import { randomUUID } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  buildR2Provider,
  env,
  FakeStorageProvider,
  r2EnvIsComplete,
  type IStorageProvider,
} from '@emapp/db';

/**
 * Phase 4 — document storage provider DI.
 *
 * Same GOVERNED pattern as D.27 EMAIL_PROVIDER / Gate-4 NoopSMSProvider:
 * the abstraction is wired now; the concrete R2 provider is dropped in at
 * THIS single factory once the Cloudflare R2 bucket + `R2_*` creds + the
 * S3 client land in Infisical (Gate-4 SECRETS LAW — user action).
 *
 * SECURITY: production must NOT silently fall back to FakeStorageProvider
 * (in-memory, mints fake URLs) — that would make every document
 * unreadable AND could mask a misconfig. So prod FAILS FAST at boot until
 * R2 is wired (a safe loud failure; recorded as a hard pre-Gate-5 gate).
 */
export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';

/** Presigned-URL lifetimes (seconds). Deliberately short — a signed URL
 * is a bearer credential; minimise the exfiltration window. */
export const UPLOAD_URL_TTL_SECONDS = 300;
export const DOWNLOAD_URL_TTL_SECONDS = 120;

/**
 * Process-wide singleton. v7 audit Agent A HIGH (and Agent C HIGH-1):
 * `storageProviderFactory` is registered as a NestJS `useFactory` in
 * THREE modules (documents, imports, signatures). Nest invokes the
 * factory once per provider token — so without memoization we would
 * boot ONE S3Client per module = three S3Clients per API process, each
 * with its own HTTPS connection pool, each scheduling its own DNS
 * resolves and TCP/TLS handshakes for what should be a shared
 * connection to the same R2 endpoint. Multiply by the worker
 * (1 extra) and we'd be wasting a measurable fraction of /import-mint
 * latency on duplicated connection setup at cold start.
 *
 * Memoizing here costs us nothing (the factory is pure on env+SDK and
 * never needs to vary across modules), keeps the IStorageProvider
 * interface unchanged, and means the FakeStorageProvider's in-memory
 * Map is also shared across modules — which is actually the right
 * behaviour for dev (an apartment uploaded via signatures should be
 * downloadable via documents in the same process).
 *
 * Tests reset by calling `resetStorageProviderForTests()`.
 */
let cachedProvider: IStorageProvider | null = null;

export function storageProviderFactory(): IStorageProvider {
  if (cachedProvider !== null) return cachedProvider;
  cachedProvider = createStorageProvider();
  return cachedProvider;
}

/** Drop the cached singleton so the next factory call builds fresh.
 *
 *  Two use cases:
 *    1. Tests — swap in a Fake with a pre-populated map.
 *    2. v8 §v7-C — credential rotation. After Infisical updates the
 *       R2_* secrets (and someone called `reloadEnv()` to re-read
 *       process.env into the @emapp/db env object), this drops the
 *       S3Client cached against the OLD credentials. The next factory
 *       call rebuilds with the new ones, without a process restart.
 *       Pair with a SIGHUP handler in main.ts.
 *
 *  Backwards-compat alias `resetStorageProviderForTests` kept so the
 *  one existing test caller doesn't break — new callers should use
 *  the unqualified name. */
export function resetStorageProvider(): void {
  cachedProvider = null;
}

/** @deprecated use `resetStorageProvider()`. */
export const resetStorageProviderForTests = resetStorageProvider;

function createStorageProvider(): IStorageProvider {
  // v6 R2 wiring: if the 4 R2_* env vars are present in Infisical
  // (any env: dev/staging/prod), construct a real R2StorageProvider.
  // Otherwise fall back per environment:
  //   dev/test  → FakeStorageProvider (in-memory; offline-friendly)
  //   production → FAIL FAST (same posture as the pre-R2 era; prevents
  //               accidentally booting prod with no real storage)
  //
  // The AWS SDK constructors are imported at the top — only the API
  // and worker apps depend on @aws-sdk/*; @emapp/db is SDK-free.
  if (r2EnvIsComplete(env)) {
    return buildR2Provider(env, {
      S3Client,
      getSignedUrl,
      PutObjectCommand,
      GetObjectCommand,
      DeleteObjectCommand,
      HeadObjectCommand,
      ListObjectsV2Command,
      // v8 Perf-7: the API factory's clients are USER-FACING (every
      // call holds a Fastify worker on the request critical path).
      // Slash the SDK's default retry-on-failure budget to 1 attempt:
      // a failed presign mint should bubble immediately to a 503
      // (the Manager clicks Retry, which is more responsive than a
      // 25s spinner during an R2 outage). The worker keeps the
      // default 3 attempts via its own factory because it's batch.
      tuning: {
        maxAttempts: 1,
      },
    });
  }
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'STORAGE_PROVIDER: refusing to boot — production requires Cloudflare ' +
        'R2 but R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / ' +
        'R2_ENDPOINT are not all set in the env. Provision R2 (bucket + ' +
        'API token + 4 secrets in Infisical) before deploying. See ' +
        'GATES Gate-5 / DECISIONS D.28.',
    );
  }
  return new FakeStorageProvider();
}

/**
 * The object key is SERVER-GENERATED and unguessable, partitioned per org
 * so a bucket-level mistake is still org-scoped. The client NEVER supplies
 * or sees this key (it is not on the wire) — only short-lived presigned
 * URLs are returned. Format: `org/<orgId>/doc/<uuid>`.
 */
export function newDocumentKey(orgId: string): string {
  return `org/${orgId}/doc/${randomUUID()}`;
}

/**
 * Sanitise a stored document name before it is used as the download
 * Content-Disposition filename: strip path separators, quotes, and
 * control chars (header-injection / response-splitting defense). Falls
 * back to a safe constant if nothing printable remains.
 */
export function safeDownloadFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) continue; // control chars
    if (ch === '"' || ch === '\\' || ch === '/') continue; // quoting / path
    out += ch;
  }
  out = out.trim().slice(0, 200);
  return out.length > 0 ? out : 'document';
}
