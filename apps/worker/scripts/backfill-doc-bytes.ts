/**
 * Backfill placeholder PDF bytes for documents whose R2 object is missing.
 *
 * The dev seed (packages/db/scripts/seed-dev.ts) created document METADATA only
 * — the file bytes were never uploaded to R2, so every seeded document 404s on
 * open ("documents don't open for reading"). This uploads a small RENDERABLE
 * placeholder PDF (one page, the doc name as text) to each non-sensitive
 * document's r2Key so View/Download work in dev. putObject is idempotent
 * (deterministic bytes), so re-running is safe. Sensitive (encrypted) docs are
 * SKIPPED — their bytes are an EMAPPENC envelope, not a raw PDF.
 *
 * Run (needs R2_* + DATABASE_URL via Infisical), from the worker package:
 *   infisical run --env=dev -- pnpm --filter @emapp/worker exec tsx scripts/backfill-doc-bytes.ts
 */
/* eslint-disable no-console -- operational backfill script */
import { buildMinimalPdf, db, documents } from '@emapp/db';
import { and, eq, isNull } from 'drizzle-orm';

import { storageProviderFactory } from '../src/storage-provider';

async function main(): Promise<void> {
  const storage = storageProviderFactory();
  const rows = await db
    .select({ id: documents.id, name: documents.name, r2Key: documents.r2Key })
    .from(documents)
    .where(and(eq(documents.sensitive, false), isNull(documents.archivedAt)));

  console.log(`Uploading placeholder PDFs for ${rows.length} non-sensitive documents…`);
  const BATCH = 25;
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await Promise.all(
      slice.map((d) =>
        storage.putObject(d.r2Key, buildMinimalPdf(d.name), { contentType: 'application/pdf' }),
      ),
    );
    n += slice.length;
    if (n % 200 === 0 || n === rows.length) console.log(`  …${n}/${rows.length}`);
  }
  console.log(`Done: uploaded ${n} placeholder PDFs to R2.`);
  process.exit(0);
}

void main().catch((e) => {
  console.error('backfill failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
