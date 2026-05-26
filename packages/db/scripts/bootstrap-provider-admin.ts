/**
 * Bootstrap the first Provider Admin account.
 *
 * Phase 6.5 audit H3 closure — there was no documented runbook for
 * creating the first `provider_admin` row in a fresh environment. Test
 * factories cover dev / CI; staging and prod need a real, reviewable
 * tool that follows the exact production auth contract.
 *
 * Usage (always via Infisical so secrets are never on disk):
 *
 *   infisical run --env=dev -- pnpm --filter @emapp/db provider:bootstrap
 *
 * Required env (passed in by the caller — never persisted):
 *   BOOTSTRAP_ADMIN_EMAIL    — the admin email (citext, unique)
 *   BOOTSTRAP_ADMIN_PASSWORD — initial password; user MUST rotate after first login
 *   BOOTSTRAP_ADMIN_NAME     — display name (e.g. "Lidor Provider Admin")
 *
 * Required Infisical env (already in dev/staging/prod):
 *   DATABASE_URL             — app pool target
 *   PII_ENCRYPTION_KEY       — pgcrypto symmetric key (MFA secret encryption)
 *   PII_HASH_KEY             — HMAC key (recovery-code hashing)
 *
 * What it does:
 *  1. Refuses if a row with that email already exists (no auto-update — destructive).
 *  2. Hashes the password with argon2id, parameters MUST match
 *     apps/api/src/modules/auth/password.ts (OWASP storage cheat sheet).
 *  3. Generates a 20-byte random TOTP secret, base32-encoded (RFC 4648
 *     no padding) — the shape `otpauth.Secret.fromBase32()` decodes at
 *     login time (provider-auth.service.ts:143).
 *  4. Encrypts the base32 secret string via pgcrypto using PII_ENCRYPTION_KEY
 *     and stores the resulting bytea in `provider_users.mfa_secret_encrypted`.
 *  5. Generates 8 random alphanumeric recovery codes (10 chars uppercase),
 *     HMAC-SHA256-hashes each with PII_HASH_KEY, stores the hash array.
 *  6. Inserts the row with role='admin' — DB_TO_JWT_ROLE in
 *     provider-auth.service.ts maps this to JWT role 'provider_admin'
 *     (Audit v1.1 SA-3 contract).
 *  7. Prints to stdout, EXACTLY ONCE:
 *       - the otpauth:// provisioning URI (paste into Google Authenticator /
 *         1Password / Authy)
 *       - the 8 plaintext recovery codes (store in 1Password)
 *     This is the only moment these values exist in plaintext. The script
 *     does NOT write them to a file. Closing the terminal without saving =
 *     re-run the script (delete the row first via psql).
 *
 * Why env vars + not CLI flags:
 *  Passwords passed on the command line appear in shell history, `ps`
 *  output, and container logs. Env vars (especially via `infisical run`)
 *  do not.
 *
 * Why no test:
 *  Bootstrap scripts are operational tools. The contract is exercised
 *  end-to-end on first login of every fresh environment — that login
 *  IS the test. The argon2 + pgcrypto + hashField primitives have their
 *  own unit coverage in `apps/api` and `packages/db`.
 */
/* eslint-disable no-console -- operational tool; stdout IS the UX. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { hash as argon2Hash } from '@node-rs/argon2';
import { eq, sql } from 'drizzle-orm';

import { closeAllPools, db } from '../src/client';
import { env } from '../src/env';
import { providerUsers } from '../src/schema/provider';

// OWASP Password Storage Cheat Sheet — MUST match apps/api/src/modules/auth/password.ts.
// A drift here means the bootstrapped account cannot log in with the same
// password the operator typed.
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// otpauth issuer label that shows up in the authenticator app row.
// Matches what users will see when they open Google Authenticator.
const TOTP_ISSUER = 'EMAPP';
const TOTP_PERIOD_SEC = 30;
const TOTP_DIGITS = 6;
const TOTP_SECRET_BYTES = 20;

// 8 single-use codes is the count expected by provider-auth.service.ts
// (the `recoveryCodesHash` array length is unchecked but enrolment has
// historically minted 8 per Doc07 §6.6).
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_LENGTH = 10;
const RECOVERY_CODE_ALPHABET = 'ABCDEFGHIJKLMNPQRSTUVWXYZ23456789'; // no O/0/1/I — typo-safe

// RFC 4648 base32 alphabet — no padding (otpauth-style).
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

function generateRecoveryCode(): string {
  const len = RECOVERY_CODE_ALPHABET.length;
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
    out += RECOVERY_CODE_ALPHABET[bytes[i]! % len];
  }
  return out;
}

function hashRecoveryCode(code: string, key: string): string {
  // Matches packages/db/src/helpers/owners.ts:hashField. Inlined here so
  // the bootstrap script does not pull in the entire owners helper graph
  // (which requires Database + transitively brings in the schema/PII
  // surface — overkill for a one-shot insert).
  return createHmac('sha256', key).update(code).digest('hex');
}

function buildOtpauthUri(email: string, secret: string): string {
  // RFC 6238 / Google Authenticator key URI format.
  // Account label = `${issuer}:${email}` (Google Authenticator convention).
  const label = encodeURIComponent(`${TOTP_ISSUER}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    period: String(TOTP_PERIOD_SEC),
    digits: String(TOTP_DIGITS),
    algorithm: 'SHA1',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function fail(message: string): number {
  console.error(`[bootstrap-provider-admin] ${message}`);
  return 1;
}

async function main(): Promise<number> {
  const email = process.env['BOOTSTRAP_ADMIN_EMAIL']?.trim().toLowerCase();
  const password = process.env['BOOTSTRAP_ADMIN_PASSWORD'];
  const name = process.env['BOOTSTRAP_ADMIN_NAME']?.trim();

  if (!email) return fail('BOOTSTRAP_ADMIN_EMAIL is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return fail(`BOOTSTRAP_ADMIN_EMAIL is malformed: ${email}`);
  if (!password) return fail('BOOTSTRAP_ADMIN_PASSWORD is required');
  if (password.length < 12) return fail('BOOTSTRAP_ADMIN_PASSWORD must be ≥ 12 characters');
  if (!name) return fail('BOOTSTRAP_ADMIN_NAME is required');

  const encKey = env.PII_ENCRYPTION_KEY;
  const hashKey = env.PII_HASH_KEY;
  if (!encKey || !hashKey) {
    return fail('PII_ENCRYPTION_KEY / PII_HASH_KEY missing — load via Infisical');
  }

  const [existing] = await db
    .select({ id: providerUsers.id })
    .from(providerUsers)
    .where(eq(providerUsers.email, email))
    .limit(1);
  if (existing) {
    return fail(
      `provider_users row already exists for ${email} (id=${existing.id}). ` +
        `To re-bootstrap, delete the row in psql first.`,
    );
  }

  const passwordHash = await argon2Hash(password, ARGON2);
  const totpSecretBase32 = generateTotpSecret();
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  const recoveryCodesHash = recoveryCodes.map((c) => hashRecoveryCode(c, hashKey));

  // Encrypt the base32 secret string via pgcrypto symmetric encryption,
  // matching encryptField() in helpers/owners.ts. The bytea result is the
  // payload provider-auth.service.ts:138 decryptField()s at login time.
  const encryptedResult = await db.execute<{ enc: Buffer }>(
    sql`SELECT pgp_sym_encrypt(${totpSecretBase32}, ${encKey}) AS enc`,
  );
  const mfaSecretEncrypted = encryptedResult.rows[0]?.enc;
  if (!mfaSecretEncrypted) return fail('pgp_sym_encrypt returned no result');

  const userId = randomUUID();
  await db.insert(providerUsers).values({
    id: userId,
    email,
    name,
    passwordHash,
    role: 'admin', // mapped to JWT 'provider_admin' via DB_TO_JWT_ROLE
    mfaSecretEncrypted,
    recoveryCodesHash,
  });

  const otpauthUri = buildOtpauthUri(email, totpSecretBase32);

  console.log('');
  console.log('========================================================');
  console.log('  Provider Admin account bootstrapped successfully');
  console.log('========================================================');
  console.log(`  Email:  ${email}`);
  console.log(`  Name:   ${name}`);
  console.log(`  ID:     ${userId}`);
  console.log(`  Role:   admin (JWT: provider_admin)`);
  console.log('');
  console.log('--- MFA provisioning URI (scan in your authenticator app) ---');
  console.log(otpauthUri);
  console.log('');
  console.log('--- Recovery codes (store in 1Password — shown ONLY now) ---');
  for (const code of recoveryCodes) {
    console.log(`  ${code}`);
  }
  console.log('');
  console.log('Next steps:');
  console.log('  1. Scan the otpauth URI above in Google Authenticator / 1Password');
  console.log('  2. Copy the 8 recovery codes into a password vault');
  console.log('  3. Log in at https://<app-host>/provider/login with email +');
  console.log('     password + the 6-digit TOTP code from your authenticator');
  console.log('  4. Rotate the password from the operator runbook');
  console.log('');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main()
    .then(async (code) => {
      await closeAllPools();
      process.exit(code);
    })
    .catch(async (err: unknown) => {
      console.error('[bootstrap-provider-admin] unexpected error:', err);
      await closeAllPools();
      process.exit(1);
    });
}
