/**
 * Bootstrap the FIRST Provider Admin (T2.10 / Doc07 §6.6).
 *
 * MFA is mandatory and enabled at creation — there is no MFA-less window.
 * Run: infisical run --env=dev -- pnpm --filter @emapp/api tsx scripts/bootstrap-provider-admin.ts <email> <name>
 *
 * Prints the password, the otpauth:// enrolment URI, and 8 single-use
 * recovery codes ONCE to stdout. They are never stored in plaintext.
 */
import { randomBytes } from 'node:crypto';

import { db, encryptField, hashField, env as dbEnv, providerUsers } from '@emapp/db';
import { eq } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';

import { hashPassword } from '../src/modules/auth/password';

function genPassword(): string {
  // 24 bytes base64url ≈ 32 chars, well above the 12-char floor.
  return randomBytes(24).toString('base64url');
}
function genRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => randomBytes(5).toString('hex')); // 10-char codes
}

async function main(): Promise<void> {
  const [email, name] = process.argv.slice(2);
  if (!email || !name) {
    process.stderr.write('usage: bootstrap-provider-admin.ts <email> <name>\n');
    process.exit(1);
  }

  const existing = await db
    .select({ id: providerUsers.id })
    .from(providerUsers)
    .where(eq(providerUsers.email, email))
    .limit(1);
  if (existing.length > 0) {
    process.stderr.write(`Provider admin ${email} already exists — aborting.\n`);
    process.exit(1);
  }

  const password = genPassword();
  const passwordHash = await hashPassword(password);

  const secret = new Secret({ size: 20 }); // 160-bit, RFC 6238
  const totp = new TOTP({ issuer: 'EMAPP', label: email, secret, period: 30, digits: 6 });
  const mfaSecretEncrypted = await encryptField(
    db,
    secret.base32,
    dbEnv.PII_ENCRYPTION_KEY as string,
  );

  const recoveryCodes = genRecoveryCodes();
  const recoveryCodesHash = recoveryCodes.map((c) => hashField(c, dbEnv.PII_HASH_KEY as string));

  await db.insert(providerUsers).values({
    email,
    name,
    passwordHash,
    role: 'admin',
    mfaSecretEncrypted,
    recoveryCodesHash,
  });

  process.stdout.write(
    [
      '',
      '=== Provider Admin created — STORE THESE NOW (shown once) ===',
      `email:       ${email}`,
      `password:    ${password}`,
      `otpauth URI: ${totp.toString()}`,
      `recovery codes:\n  ${recoveryCodes.join('\n  ')}`,
      '=============================================================',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`bootstrap failed: ${String(err)}\n`);
  process.exit(1);
});
