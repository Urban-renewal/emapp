/**
 * Seed-side storage helper — uploads the shared renderable {@link MINIMAL_PDF}
 * for documents created by a seed run, so a freshly-seeded dev DB has openable
 * document previews (the owner bar: preview MUST work locally).
 *
 * Provider selection mirrors the app factories:
 *   - R2_* present  → REAL Cloudflare R2 (shared + persistent across the seed
 *     process and the running API process — this is the path that actually
 *     makes preview work).
 *   - R2_* missing  → in-memory FakeStorageProvider, which CANNOT be seen by the
 *     separately-running API process. In that case we SKIP the upload and return
 *     `false` so the seed prints an honest "metadata only" note instead of
 *     pretending bytes are available.
 *
 * @emapp/db stays AWS-SDK-free in its product build; the SDK is a scripts-only
 * devDependency injected into the shared `buildR2Provider`.
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

import { env } from '../src/env';
import { buildMinimalPdf } from '../src/fixtures/minimal-pdf';
import { buildR2Provider, r2EnvIsComplete } from '../src/providers/storage/r2-factory';
import type { IStorageProvider } from '../src/providers/storage/storage.interface';

/** Returns a REAL R2 storage provider iff the R2_* env vars are configured,
 *  else `null` (the seed should then skip byte uploads). */
export function seedStorageOrNull(): IStorageProvider | null {
  if (!r2EnvIsComplete(env)) return null;
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

/**
 * Upload a renderable PDF (the doc name printed on the page) to each given
 * `{ r2Key, name }`. No-op returning `false` when R2 is not configured.
 * Idempotent — `putObject` overwrites.
 *
 * @returns `true` when bytes were uploaded to real R2, `false` when skipped.
 */
export async function uploadSeedDocBytes(
  docs: ReadonlyArray<{ r2Key: string; name: string }>,
): Promise<boolean> {
  const storage = seedStorageOrNull();
  if (storage === null || docs.length === 0) return false;
  const BATCH = 25;
  for (let i = 0; i < docs.length; i += BATCH) {
    const slice = docs.slice(i, i + BATCH);
    await Promise.all(
      slice.map((d) =>
        storage.putObject(d.r2Key, buildMinimalPdf(d.name), {
          contentType: 'application/pdf',
        }),
      ),
    );
  }
  return true;
}
