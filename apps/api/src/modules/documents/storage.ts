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
  // Dev/test fallback: R2 is incomplete and we are NOT in production.
  //
  // The owner-confusion root-cause this branch fixes: previously we
  // SILENTLY returned a plain FakeStorageProvider whose getUploadUrl/
  // getDownloadUrl mint `https://fake-storage.test/…` URLs. The browser
  // then 404s on document view/download/preview with NO clue why (the
  // owner had a missing R2_ACCESS_KEY_ID and saw only "key does not
  // exist"). Two changes make it OBVIOUS:
  //
  //   1. NODE_ENV!=='test' → emit a LOUD boot warning naming EXACTLY
  //      which R2_* vars are empty (names only, never values).
  //   2. NODE_ENV!=='test' → construct the fake with
  //      `failUrlsOutsideTest: true`, so the next document upload/
  //      download mint throws the actionable "storage not configured"
  //      error instead of the silent 404-bound fake URL.
  //
  // Under NODE_ENV==='test' NEITHER applies — the fake behaves exactly
  // as before (in-memory store, URLs minted, no warning, no throw) so
  // the storage/worker specs are byte-for-byte unaffected.
  const isTest = process.env['NODE_ENV'] === 'test';
  if (!isTest) {
    warnStorageNotConfigured();
  }
  return new FakeStorageProvider({ failUrlsOutsideTest: !isTest });
}

/** The 4 R2_* vars the storage layer requires (mirrors r2EnvIsComplete). */
const REQUIRED_R2_VARS = [
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_ENDPOINT',
] as const;

/**
 * Emit ONE loud, structured boot warning naming exactly which R2_* vars
 * are empty. Names ONLY the missing variable NAMES — never their values —
 * so nothing sensitive is logged. No app-wide logger is threaded through
 * this composition-root factory, so a clearly-prefixed `console.warn` is
 * the sanctioned channel here (it fires once, at boot, when the dev fake
 * is selected).
 */
function warnStorageNotConfigured(): void {
  const missing = REQUIRED_R2_VARS.filter((name) => !env[name]);
  // Defensive: r2EnvIsComplete was false, so at least one is missing.
  const missingList = missing.length > 0 ? missing.join(', ') : REQUIRED_R2_VARS.join(', ');
  // eslint-disable-next-line no-console
  console.warn(
    `[storage] ⚠️ R2 NOT CONFIGURED — missing env var(s): ${missingList}. ` +
      'Document upload/download/preview will NOT work until these are set ' +
      'in Infisical; using in-memory FakeStorageProvider.',
  );
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
 * Sanitise a stored document name before it is used as the RFC 6266
 * `filename="…"` slot of Content-Disposition.
 *
 * Audit H-2 fix (2026-05-27 manager-be-redteam): previously kept `;`,
 * `=`, `,`, and non-ASCII bytes — strict parsers (curl, AV scanners)
 * could be fooled into picking an attacker-chosen filename out of an
 * embedded `; filename=evil.exe`, and Hebrew bytes broke RFC 6266
 * compliance entirely. Now ASCII-printable only, also strips the
 * parameter delimiters. The original (Hebrew-capable) name flows
 * through the separate `responseFilenameUtf8` channel into the
 * `filename*=UTF-8''…` slot.
 */
export function safeDownloadFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) continue; // control chars
    if (c > 0x7e) continue; // non-ASCII — use the UTF-8 channel instead
    if (
      ch === '"' || // closes the filename="..." quote
      ch === '\\' || // backslash escape
      ch === '/' || // path
      ch === ';' || // splits the header param list
      ch === '=' || // would start a fake `filename=` param
      ch === ',' // splits multi-value headers
    )
      continue;
    out += ch;
  }
  out = out.trim().slice(0, 200);
  return out.length > 0 ? out : 'document';
}
