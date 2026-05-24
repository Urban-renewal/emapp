/**
 * R2 credentials smoke test — verify the one-time-display values BEFORE
 * closing the Cloudflare window.
 *
 * Runs four checks against the bucket using the AWS SDK in S3-compatible
 * mode:
 *   1. HeadBucket  — does the bucket exist + are the creds valid?
 *   2. PutObject   — can we write?
 *   3. GetObject   — can we read what we wrote?
 *   4. DeleteObject — can we clean up?
 *
 * If all four pass, your R2_* values are correct + the token has the
 * right permissions ("Object Read & Write" scoped to the bucket).
 *
 * Read env vars directly from process.env (NOT through @emapp/db's
 * env validator) so you can run this BEFORE adding the values to
 * Infisical — supply them inline:
 *
 *   $env:R2_ACCESS_KEY_ID = "..."
 *   $env:R2_SECRET_ACCESS_KEY = "..."
 *   $env:R2_BUCKET = "emapp-dev"
 *   $env:R2_ENDPOINT = "https://<account-id>.eu.r2.cloudflarestorage.com"
 *   node scripts/verify-r2.mjs
 *
 * No app code is touched. This script is self-contained; it can be
 * deleted after verification (or kept as the canonical R2 smoke test).
 */
import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const required = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`✗ missing env vars: ${missing.join(', ')}`);
  console.error('  set them in your shell first; see the comment block at the top of this file.');
  process.exit(2);
}

const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET;
const ENDPOINT = process.env.R2_ENDPOINT;
const TEST_KEY = `__verify-r2-smoke-${Date.now()}.txt`;
const TEST_BODY = 'hello r2 from emapp verify-r2.mjs';

const client = new S3Client({
  region: 'auto', // R2 ignores region but the SDK requires the field
  endpoint: ENDPOINT,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: false, // R2 uses virtual-hosted style; the endpoint already encodes the account-id
});

const log = (status, step, msg) => {
  const icon = status === 'ok' ? '✓' : status === 'fail' ? '✗' : '·';
  console.log(`${icon} ${step.padEnd(14)} ${msg}`);
};

let step = 'init';
try {
  log('info', 'config', `bucket=${BUCKET} endpoint=${ENDPOINT}`);

  step = 'HeadBucket';
  await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
  log('ok', step, 'bucket exists + credentials valid');

  step = 'PutObject';
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: TEST_KEY,
      Body: TEST_BODY,
      ContentType: 'text/plain',
    }),
  );
  log('ok', step, `wrote ${TEST_KEY}`);

  step = 'GetObject';
  const get = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: TEST_KEY }));
  const body = await get.Body.transformToString();
  if (body !== TEST_BODY) {
    log('fail', step, `body mismatch: expected ${JSON.stringify(TEST_BODY)} got ${JSON.stringify(body)}`);
    process.exit(1);
  }
  log('ok', step, `read back ${body.length} bytes, content matches`);

  step = 'DeleteObject';
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: TEST_KEY }));
  log('ok', step, `cleaned up ${TEST_KEY}`);

  console.log('');
  console.log('🎉 all four checks passed — R2 credentials are correct + scoped right.');
  console.log('   safe to close the one-time-display window in Cloudflare.');
  console.log('   next: add the 4 R2_* values to Infisical (--env=dev).');
} catch (e) {
  log('fail', step, e?.name ?? 'UnknownError');
  console.error('');
  console.error('details:');
  console.error(`  message:    ${e?.message ?? 'no message'}`);
  console.error(`  status:     ${e?.$metadata?.httpStatusCode ?? 'unknown'}`);
  console.error(`  code:       ${e?.Code ?? e?.name ?? 'unknown'}`);
  console.error('');
  console.error('common causes:');
  console.error('  · 403 SignatureDoesNotMatch → R2_SECRET_ACCESS_KEY copied wrong (check for trailing space)');
  console.error('  · 403 InvalidAccessKeyId    → R2_ACCESS_KEY_ID copied wrong');
  console.error('  · 404 NoSuchBucket          → R2_BUCKET name typo OR token scoped to a different bucket');
  console.error('  · ENOTFOUND / ECONNREFUSED  → R2_ENDPOINT typo (must be https://<account-id>.eu.r2.cloudflarestorage.com)');
  console.error('  · 403 AccessDenied on Put   → token permission is "Object Read" — must be "Object Read & Write"');
  console.error('');
  console.error('DO NOT close the Cloudflare window yet — copy the values again carefully + re-run.');
  process.exit(1);
}
