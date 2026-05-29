/* AUDIT TOOL (not a product path): forge a known OTP code for a known owner
 * so the auditor can complete the resident OTP→portal flow deterministically
 * (dev NoopSMS code is unrecoverable + dev DB phone hashes are un-normalized).
 * Inserts an otp_codes row whose phone_hash matches what verify() computes. */
/* eslint-disable no-console */
import { pathToFileURL } from 'url';

import { normalizeIsraeliPhone } from '@emapp/validators';

import { db, closeAllPools } from '../src/client';
import { env } from '../src/env';
import { hashField } from '../src/helpers/owners';
import { otpCodes } from '../src/schema/index';

async function main() {
  const phoneRaw = process.argv[2] ?? '0510000000';
  const ownerId = process.argv[3]!;
  const orgId = process.argv[4]!;
  const code = '123456';
  const norm = normalizeIsraeliPhone(phoneRaw);
  if (!norm) throw new Error(`phone ${phoneRaw} did not normalize`);
  const key = env.PII_HASH_KEY as string;
  const phoneHash = hashField(norm, key);
  const codeHash = hashField(code, key);
  await db.insert(otpCodes).values({
    phoneHash,
    codeHash,
    ownerId,
    orgId,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  console.log(`FORGED phone=${phoneRaw} norm=${norm} code=${code} owner=${ownerId}`);
}
const isCli =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli)
  main()
    .then(async () => {
      await closeAllPools();
      process.exit(0);
    })
    .catch(async (e) => {
      console.error('ERR', e.message);
      await closeAllPools();
      process.exit(1);
    });
