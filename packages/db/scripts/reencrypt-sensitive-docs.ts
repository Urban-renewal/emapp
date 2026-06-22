/**
 * Gate-6 — RE-ENCRYPT every SENSITIVE document whose bytes are PLAINTEXT at rest.
 *
 * The confirmed-critical vuln: `documents.sensitive` and `documents.bytes_encrypted`
 * drifted apart. `update`-retype and `remediationSweep` flip `sensitive=true`
 * WITHOUT re-encrypting, so PII-dense נסח / id_document objects (every owner's
 * national_id) sit in R2 in the clear and were plain-presigned — including to
 * UNAUTHENTICATED signers. The code paths are now fixed forward (re-encrypt on
 * flip + serving fail-close), but the EXISTING population (census: ~750 docs)
 * must be remediated. This script does that, safely.
 *
 * What it does (per candidate = sensitive && !bytes_encrypted && uploaded && live):
 *   - HEAD the object:
 *       · missing on R2 (head === null / NoSuchKey)        → QUARANTINE (log; skip)
 *       · contentLength <= STUB_MAX_BYTES (21-byte QA stub) → QUARANTINE (log; skip)
 *   - read the plaintext bytes;
 *       · already an EMAPPENC envelope (idempotent re-run)  → just repair the flag
 *       · else encrypt → EMAPPENC envelope → overwrite the object → VERIFY the
 *         round-trip (decrypt back, compare to the original bytes) → set
 *         bytes_encrypted=true. If verify fails, the object is NOT marked
 *         encrypted (fail-safe; reported).
 *
 * SAFETY POSTURE:
 *   - DRY-RUN BY DEFAULT: reports what WOULD happen, mutates NOTHING (no R2 write,
 *     no DB update). Pass `--apply` to actually re-encrypt.
 *   - IDEMPOTENT: a re-run skips docs already bytes_encrypted=true and never
 *     double-wraps an object that is already an envelope.
 *   - RESUMABLE: each doc is processed independently and the DB flag is the
 *     resume marker — a crash/abort mid-run just leaves the unprocessed docs as
 *     candidates for the next run.
 *   - ROUND-TRIP VERIFIED: a doc is marked bytes_encrypted=true ONLY after the
 *     envelope decrypts back to the exact original bytes under the same key.
 *   - The plaintext / ciphertext bytes are NEVER logged; only ids + sizes +
 *     outcomes.
 *
 * REQUIRES (via Infisical): DATABASE_URL (the BYPASSRLS provider pool is used —
 * a cross-org maintenance sweep), R2_* (real Cloudflare R2), DOC_ENCRYPTION_KEY.
 *
 * Run (DRY-RUN — default; safe):
 *   infisical run --env=staging -- pnpm --filter @emapp/db reencrypt:sensitive
 * Run (APPLY — owner-gated, AFTER reviewing the dry-run):
 *   infisical run --env=staging -- pnpm --filter @emapp/db reencrypt:sensitive -- --apply
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
import { and, asc, eq, isNotNull } from 'drizzle-orm';

import {
  DocEnvelopeConfigError,
  DocEnvelopeKeyRegistry,
  buildR2Provider,
  decryptDocEnvelope,
  documents,
  encryptDocEnvelope,
  env,
  looksLikeDocEnvelope,
  providerDb,
  r2EnvIsComplete,
  type IStorageProvider,
} from '../src/index';

/** The known QA-stub size ("sig doc <ms>" written as application/pdf). Any
 *  object at or below this is a non-document stub, never real PII — quarantine
 *  it for manual handling rather than encrypting garbage. */
const STUB_MAX_BYTES = 32;

const APPLY = process.argv.includes('--apply');

type Outcome =
  | 'would_reencrypt'
  | 'reencrypted'
  | 'already_encrypted'
  | 'quarantined_missing'
  | 'quarantined_stub'
  | 'verify_failed'
  | 'error';

interface Report {
  total: number;
  byOutcome: Record<Outcome, number>;
  quarantined: Array<{ id: string; reason: 'missing' | 'stub'; r2Key: string }>;
  failures: Array<{ id: string; reason: string }>;
}

function resolveStorage(): IStorageProvider {
  if (!r2EnvIsComplete(env)) {
    console.error(
      '[reencrypt] ❌ R2 is NOT configured (R2_* env vars missing). This script must run ' +
        'against REAL Cloudflare R2 — re-run via Infisical so the R2_* secrets are present.',
    );
    process.exit(2);
  }
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

/** Bounded read of an object's bytes (the presign already caps the PUT; this is
 *  defense-in-depth). Destroys the stream so no R2 connection leaks. */
async function readBytes(
  storage: IStorageProvider,
  key: string,
  maxBytes: number,
): Promise<Buffer> {
  const stream = await storage.getObjectStream(key);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > maxBytes) throw new Error('object_exceeds_ceiling');
      chunks.push(buf);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const storage = resolveStorage();

  // Fail-closed key load up front — never start a sweep with a bad key registry.
  let registry: DocEnvelopeKeyRegistry;
  try {
    registry = DocEnvelopeKeyRegistry.fromEnv(env.DOC_ENCRYPTION_KEY);
  } catch (e) {
    const reason = e instanceof DocEnvelopeConfigError ? e.reason : 'unknown';
    console.error(`[reencrypt] ❌ DOC_ENCRYPTION_KEY is invalid (${reason}) — refusing to run.`);
    process.exit(2);
  }

  console.log(
    `[reencrypt] mode=${APPLY ? 'APPLY (will mutate R2 + DB)' : 'DRY-RUN (no mutation)'} — ` +
      `scanning sensitive && !bytes_encrypted && uploaded && live documents…`,
  );

  // CANDIDATE SET (cross-org maintenance via the BYPASSRLS provider pool):
  // sensitive, NOT yet encrypted, uploaded (has bytes at rest). ARCHIVED rows
  // are INCLUDED on purpose: an archived sensitive object is still PLAINTEXT
  // PII at rest in R2 (archived ≠ shredded — the object lingers), and the 0080
  // CHECK validates ALL rows with no archived exemption, so an archived
  // violating row would abort `ADD CONSTRAINT` in prod. We must re-encrypt
  // them too.
  // Ordered by id for a STABLE, RESUMABLE walk (the bytes_encrypted flip is the
  // real resume marker — a re-run never re-selects an already-fixed doc).
  const rows = await providerDb
    .select({
      id: documents.id,
      r2Key: documents.r2Key,
      sizeBytes: documents.sizeBytes,
    })
    .from(documents)
    .where(
      and(
        eq(documents.sensitive, true),
        eq(documents.bytesEncrypted, false),
        isNotNull(documents.uploadedAt),
      ),
    )
    .orderBy(asc(documents.id));

  const report: Report = {
    total: rows.length,
    byOutcome: {
      would_reencrypt: 0,
      reencrypted: 0,
      already_encrypted: 0,
      quarantined_missing: 0,
      quarantined_stub: 0,
      verify_failed: 0,
      error: 0,
    },
    quarantined: [],
    failures: [],
  };

  console.log(`[reencrypt] ${rows.length} candidate document(s).`);

  const MAX_READ = 52_428_800 + 64; // DOCUMENT_MAX_SIZE_BYTES + envelope header slack
  let n = 0;
  for (const row of rows) {
    n += 1;
    try {
      // 1) HEAD — detect a missing object (NoSuchKey) or a tiny QA stub WITHOUT
      //    downloading. head() returns null for absent objects.
      const meta = await storage.head(row.r2Key);
      if (meta === null) {
        report.byOutcome.quarantined_missing += 1;
        report.quarantined.push({ id: row.id, reason: 'missing', r2Key: row.r2Key });
        continue;
      }
      if (meta.contentLength <= STUB_MAX_BYTES) {
        report.byOutcome.quarantined_stub += 1;
        report.quarantined.push({ id: row.id, reason: 'stub', r2Key: row.r2Key });
        continue;
      }

      // 2) Read the bytes.
      const bytes = await readBytes(storage, row.r2Key, MAX_READ);

      // 3) Idempotency — already an EMAPPENC envelope? Repair the flag only,
      //    but ONLY after a full decrypt round-trip proves it is genuinely
      //    decryptable under the configured registry. A garbled/forged
      //    EMAPPENC-prefixed object must NEVER be marked bytes_encrypted=true
      //    (that would fail-OPEN the serving path on an undecryptable doc). On a
      //    decrypt failure we report it for investigation and leave the flag
      //    false (the serving fail-close then refuses it).
      if (looksLikeDocEnvelope(bytes)) {
        let decryptable = false;
        try {
          decryptDocEnvelope(bytes, registry);
          decryptable = true;
        } catch {
          decryptable = false;
        }
        if (!decryptable) {
          report.byOutcome.verify_failed += 1;
          report.failures.push({ id: row.id, reason: 'existing_envelope_undecryptable' });
          continue;
        }
        report.byOutcome.already_encrypted += 1;
        if (APPLY) {
          await providerDb
            .update(documents)
            .set({ bytesEncrypted: true, updatedAt: new Date() })
            .where(eq(documents.id, row.id));
        }
        continue;
      }

      // DRY-RUN — report and move on (NO R2 write, NO DB update).
      if (!APPLY) {
        report.byOutcome.would_reencrypt += 1;
        continue;
      }

      // 4) Encrypt → overwrite → VERIFY round-trip → flip the flag.
      const envelope = encryptDocEnvelope(bytes, registry);
      const verifyPlain = decryptDocEnvelope(envelope, registry);
      if (!verifyPlain.equals(bytes)) {
        // Never marks the doc encrypted on a verify miss — the original object
        // is untouched (we have not written yet). Report for investigation.
        report.byOutcome.verify_failed += 1;
        report.failures.push({ id: row.id, reason: 'pre_write_roundtrip_mismatch' });
        continue;
      }
      await storage.putObject(row.r2Key, envelope, { contentType: 'application/octet-stream' });
      // Read back what we actually stored and decrypt — confirms the overwrite
      // landed and is decryptable before we trust it in the DB.
      const stored = await readBytes(storage, row.r2Key, MAX_READ);
      const decrypted = decryptDocEnvelope(stored, registry);
      if (!decrypted.equals(bytes)) {
        report.byOutcome.verify_failed += 1;
        report.failures.push({ id: row.id, reason: 'post_write_roundtrip_mismatch' });
        continue;
      }
      await providerDb
        .update(documents)
        .set({ bytesEncrypted: true, updatedAt: new Date() })
        .where(eq(documents.id, row.id));
      report.byOutcome.reencrypted += 1;
    } catch (e) {
      report.byOutcome.error += 1;
      report.failures.push({ id: row.id, reason: e instanceof Error ? e.message : 'unknown' });
    }
    if (n % 50 === 0 || n === rows.length) {
      console.log(`[reencrypt]   …processed ${n}/${rows.length}`);
    }
  }

  console.log('\n[reencrypt] ───────── SUMMARY ─────────');
  console.log(`[reencrypt] mode:                ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[reencrypt] candidates:          ${report.total}`);
  console.log(`[reencrypt] would_reencrypt:     ${report.byOutcome.would_reencrypt}`);
  console.log(`[reencrypt] reencrypted:         ${report.byOutcome.reencrypted}`);
  console.log(`[reencrypt] already_encrypted:   ${report.byOutcome.already_encrypted}`);
  console.log(`[reencrypt] quarantined_missing: ${report.byOutcome.quarantined_missing}`);
  console.log(`[reencrypt] quarantined_stub:    ${report.byOutcome.quarantined_stub}`);
  console.log(`[reencrypt] verify_failed:       ${report.byOutcome.verify_failed}`);
  console.log(`[reencrypt] error:               ${report.byOutcome.error}`);
  if (report.quarantined.length > 0) {
    console.log('\n[reencrypt] QUARANTINED (manual handling — NOT re-encrypted):');
    for (const q of report.quarantined) {
      console.log(`[reencrypt]   ${q.id}  reason=${q.reason}  r2Key=${q.r2Key}`);
    }
  }
  if (report.failures.length > 0) {
    console.log('\n[reencrypt] FAILURES (investigate):');
    for (const f of report.failures) {
      console.log(`[reencrypt]   ${f.id}  reason=${f.reason}`);
    }
  }
  console.log('[reencrypt] ─────────────────────────────');

  // Non-zero exit if anything failed verification or errored, so CI / an
  // operator notices. Quarantines are EXPECTED (missing/stub) → exit 0.
  const hadFailures = report.byOutcome.verify_failed > 0 || report.byOutcome.error > 0;
  process.exit(hadFailures ? 1 : 0);
}

void main().catch((e: unknown) => {
  console.error('[reencrypt] failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
