/**
 * Backfill renderable PDF bytes for EVERY existing `documents` row.
 *
 * The problem this fixes
 * ----------------------
 * Dev seeds (seed-dev / seed-demo) create document METADATA only — no file
 * bytes were ever written to storage — so opening a seeded document 404s. A
 * separate ad-hoc QA flow once wrote a 21-byte text stub ("sig doc <ms>")
 * served as application/pdf, which no PDF viewer renders. The owner bar is:
 * document preview MUST work locally.
 *
 * This script iterates the documents table and writes the shared, genuinely
 * renderable {@link MINIMAL_PDF} (via {@link buildMinimalPdf}, so the doc name
 * is printed on the page) to each row's `r2Key`. `putObject` overwrites, so the
 * script is IDEMPOTENT — re-running just rewrites the same valid PDF.
 *
 * Sensitive (encrypted) documents are SKIPPED: their at-rest object is an
 * EMAPPENC AES-GCM envelope, not a raw PDF (the API decrypt-stream path expects
 * the envelope). Overwriting those with a plaintext PDF would break the
 * download path, and they are a small minority of dev docs.
 *
 * Storage target
 * --------------
 * Uses the SAME provider selection as the apps: if the four R2_* env vars are
 * present it writes to REAL Cloudflare R2 (shared + persistent across
 * processes — this is the path the orchestrator must use). If R2 is NOT
 * configured it falls back to an in-memory FakeStorageProvider and EXITS with
 * a loud warning, because in-memory bytes written by this standalone process do
 * NOT reach the separately-running API process — they would not fix preview.
 *
 * @emapp/db is deliberately AWS-SDK-free at runtime; the SDK is a scripts-only
 * devDependency here (same category as `tsx`), injected into the shared
 * `buildR2Provider` so the package's product build stays SDK-free.
 *
 * Run (needs R2_* + DATABASE_URL via Infisical):
 *   infisical run --env=dev -- pnpm --filter @emapp/db exec tsx scripts/backfill-doc-bytes.ts
 */
/* eslint-disable no-console -- operational backfill script */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, eq, isNull } from 'drizzle-orm';

import {
  buildMinimalPdf,
  buildR2Provider,
  db,
  documents,
  env,
  FakeStorageProvider,
  r2EnvIsComplete,
  type IStorageProvider,
} from '../src/index';

function resolveStorage(): { storage: IStorageProvider; isReal: boolean } {
  if (r2EnvIsComplete(env)) {
    const storage = buildR2Provider(env, {
      S3Client,
      getSignedUrl,
      PutObjectCommand,
      GetObjectCommand,
      DeleteObjectCommand,
      HeadObjectCommand,
      ListObjectsV2Command,
    });
    return { storage, isReal: true };
  }
  return { storage: new FakeStorageProvider(), isReal: false };
}

async function main(): Promise<void> {
  const { storage, isReal } = resolveStorage();
  if (!isReal) {
    console.warn(
      '[backfill] ⚠️ R2 is NOT configured (R2_* env vars missing). Falling back to ' +
        'in-memory FakeStorageProvider — bytes written by THIS process will NOT be ' +
        'visible to the running API process, so document preview will still fail. ' +
        'Re-run with Infisical so the real R2_* secrets are present:\n' +
        '  infisical run --env=dev -- pnpm --filter @emapp/db exec tsx scripts/backfill-doc-bytes.ts',
    );
  }

  // Non-sensitive, non-archived docs only. Sensitive docs hold an EMAPPENC
  // envelope at rest, not a raw PDF — overwriting them with plaintext would
  // break the decrypt-stream download path.
  const rows = await db
    .select({ id: documents.id, name: documents.name, r2Key: documents.r2Key })
    .from(documents)
    .where(and(eq(documents.sensitive, false), isNull(documents.archivedAt)));

  console.log(
    `[backfill] uploading renderable MINIMAL_PDF to ${rows.length} non-sensitive ` +
      `document(s) via ${isReal ? 'REAL R2' : 'in-memory Fake'}…`,
  );

  const BATCH = 25;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await Promise.all(
      slice.map((d) =>
        storage.putObject(d.r2Key, buildMinimalPdf(d.name), {
          contentType: 'application/pdf',
        }),
      ),
    );
    done += slice.length;
    if (done % 200 === 0 || done === rows.length) {
      console.log(`[backfill]   …${done}/${rows.length}`);
    }
  }

  console.log(`[backfill] done — wrote ${done} renderable PDF(s).`);
  process.exit(isReal ? 0 : 2);
}

void main().catch((e: unknown) => {
  console.error('[backfill] failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
