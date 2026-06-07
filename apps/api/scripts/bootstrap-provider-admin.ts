/**
 * Bootstrap / recover a Provider Admin (T2.10 / Doc07 §6.6).
 *
 * MFA is mandatory and enabled at creation — there is no MFA-less window.
 *
 * CREATE the first admin:
 *   infisical run --env=dev -- pnpm --filter @emapp/api tsx \
 *     scripts/bootstrap-provider-admin.ts <email> <name>
 *
 * RECOVER a locked-out admin (B-PROVIDER-1 — when the sole admin loses their
 * TOTP device AND their recovery codes, there was previously NO way back in
 * short of raw DB surgery). Re-issues password + MFA secret + recovery codes
 * for an EXISTING admin (does NOT create one):
 *   infisical run --env=dev -- pnpm --filter @emapp/api tsx \
 *     scripts/bootstrap-provider-admin.ts --reset-mfa <email>
 *
 * Both modes require infra access (DB creds via Infisical) — the same trust
 * boundary as the original bootstrap; the reset is not an additional privilege.
 * Prints the password, the otpauth:// enrolment URI, and 8 single-use recovery
 * codes ONCE to stdout. They are never stored in plaintext.
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

/** Generate a fresh credential bundle (password + MFA secret + recovery codes)
 *  shared by create + reset so the two paths can never drift. */
async function genCredentials(email: string): Promise<{
  password: string;
  passwordHash: string;
  totp: TOTP;
  mfaSecretEncrypted: string;
  recoveryCodes: string[];
  recoveryCodesHash: string[];
}> {
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
  return { password, passwordHash, totp, mfaSecretEncrypted, recoveryCodes, recoveryCodesHash };
}

function printCredentials(
  header: string,
  email: string,
  c: Awaited<ReturnType<typeof genCredentials>>,
): void {
  process.stdout.write(
    [
      '',
      `=== ${header} — STORE THESE NOW (shown once) ===`,
      `email:       ${email}`,
      `password:    ${c.password}`,
      `otpauth URI: ${c.totp.toString()}`,
      `recovery codes:\n  ${c.recoveryCodes.join('\n  ')}`,
      '=============================================================',
      '',
    ].join('\n'),
  );
}

async function resetMfa(email: string): Promise<void> {
  const existing = await db
    .select({ id: providerUsers.id })
    .from(providerUsers)
    .where(eq(providerUsers.email, email))
    .limit(1);
  if (existing.length === 0) {
    process.stderr.write(
      `No provider admin ${email} — nothing to reset (use create mode first).\n`,
    );
    process.exit(1);
  }

  const c = await genCredentials(email);
  // Re-issue ALL auth factors in one UPDATE. Any prior TOTP secret + recovery
  // codes are overwritten, so a lost device + lost codes no longer locks the
  // account out permanently. A temporary failed-login lock (if any) auto-clears
  // within the lockout window; this restores the ability to authenticate.
  await db
    .update(providerUsers)
    .set({
      passwordHash: c.passwordHash,
      mfaSecretEncrypted: c.mfaSecretEncrypted,
      recoveryCodesHash: c.recoveryCodesHash,
    })
    .where(eq(providerUsers.email, email));

  printCredentials('Provider Admin MFA RESET', email, c);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === '--reset-mfa') {
    const email = args[1];
    if (!email) {
      process.stderr.write('usage: bootstrap-provider-admin.ts --reset-mfa <email>\n');
      process.exit(1);
    }
    await resetMfa(email);
    return;
  }

  const [email, name] = args;
  if (!email || !name) {
    process.stderr.write(
      'usage: bootstrap-provider-admin.ts <email> <name>\n' +
        '       bootstrap-provider-admin.ts --reset-mfa <email>\n',
    );
    process.exit(1);
  }

  const existing = await db
    .select({ id: providerUsers.id })
    .from(providerUsers)
    .where(eq(providerUsers.email, email))
    .limit(1);
  if (existing.length > 0) {
    process.stderr.write(
      `Provider admin ${email} already exists — aborting. ` +
        `To recover a locked-out admin, use: --reset-mfa ${email}\n`,
    );
    process.exit(1);
  }

  const c = await genCredentials(email);
  await db.insert(providerUsers).values({
    email,
    name,
    passwordHash: c.passwordHash,
    role: 'admin',
    mfaSecretEncrypted: c.mfaSecretEncrypted,
    recoveryCodesHash: c.recoveryCodesHash,
  });

  printCredentials('Provider Admin created', email, c);
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`bootstrap failed: ${String(err)}\n`);
  process.exit(1);
});
