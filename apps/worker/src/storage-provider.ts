/**
 * Worker storage-provider factory — Phase 6 + v6 R2 wiring.
 *
 * Mirror of apps/api/src/modules/documents/storage.ts (same
 * R2-or-Fake-or-Fail logic). Both apps construct from the SAME 4
 * R2_* env vars in Infisical — they share a bucket.
 *
 *  - When R2_* env vars are ALL present → real R2StorageProvider
 *    (works in dev / staging / prod alike)
 *  - When ANY R2_* is missing:
 *      dev/test   → FakeStorageProvider (in-memory)
 *      production → FAIL FAST (refuses to boot — same posture as the
 *                   pre-R2 era; prevents prod silently using Fake)
 *
 * Lives in apps/worker/ (not @emapp/db) because each app boots its own
 * provider — dependency-injected at the application composition root.
 * The factory pattern keeps the IStorageProvider import boundary
 * uniform across apps/api and apps/worker.
 *
 * NOT exposed via NestJS DI (the worker has no Nest container) — the
 * worker's composition root is `main.ts`, which constructs the
 * provider once and passes it into the handler.
 */
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

// v8 §v7-C: memoize so SIGHUP can drop the cached singleton and the
// next call rebuilds against rotated R2 credentials. Without this,
// every invocation would already rebuild (the worker only calls the
// factory once at boot) — but exposing `resetStorageProvider()` keeps
// the symmetry with the API factory and enables hot reload without a
// process restart.
let cached: IStorageProvider | null = null;

export function storageProviderFactory(): IStorageProvider {
  if (cached !== null) return cached;
  cached = createWorkerStorageProvider();
  return cached;
}

/** v8 §v7-C — drop the cached singleton (used by the SIGHUP handler
 *  after a credential rotation). */
export function resetStorageProvider(): void {
  cached = null;
}

function createWorkerStorageProvider(): IStorageProvider {
  if (r2EnvIsComplete(env)) {
    return buildR2Provider(env, {
      S3Client,
      getSignedUrl,
      PutObjectCommand,
      GetObjectCommand,
      DeleteObjectCommand,
      HeadObjectCommand,
      ListObjectsV2Command,
      // v8 Perf-7 (mirror): the worker keeps the default maxAttempts=3
      // (it's batch — a transient R2 hiccup deserves the retry), but
      // we pass tuning explicitly to make the policy auditable.
    });
  }
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'STORAGE_PROVIDER (worker): refusing to boot — production requires ' +
        'Cloudflare R2 but R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / ' +
        'R2_BUCKET / R2_ENDPOINT are not all set in the env. Provision ' +
        'R2 (bucket + API token + 4 secrets in Infisical) before ' +
        'deploying. See GATES Gate-5 / DECISIONS D.28.',
    );
  }
  return new FakeStorageProvider();
}
