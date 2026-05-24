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

export function storageProviderFactory(): IStorageProvider {
  if (r2EnvIsComplete(env)) {
    return buildR2Provider(env, {
      S3Client,
      getSignedUrl,
      PutObjectCommand,
      GetObjectCommand,
      DeleteObjectCommand,
      HeadObjectCommand,
      ListObjectsV2Command,
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
