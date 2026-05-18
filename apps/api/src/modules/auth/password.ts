import { hash, verify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet: argon2id, m=19456 KiB, t=2, p=1.
// @node-rs/argon2 defaults algorithm to Argon2id; set explicitly is a const
// enum (blocked by isolatedModules), so we rely on the documented default.
const ARGON2 = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

// Pre-computed at MODULE LOAD (not lazily on first unknown-user request —
// that made the first post-boot probe pay 2× and leak via timing). Verifying
// against it on the unknown-user / locked path keeps login timing ~constant
// (Doc07 §6.12.1 anti-enumeration).
const DUMMY_HASH_P: Promise<string> = hash('constant-time-dummy-secret', ARGON2);
// Surface load-time failures instead of an unhandled rejection.
DUMMY_HASH_P.catch(() => undefined);

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2);
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, ARGON2);
  } catch {
    return false;
  }
}

// Run a real argon2 verify against a dummy hash so the unknown-user branch
// costs the same as the wrong-password branch.
export async function dummyVerify(plain: string): Promise<void> {
  try {
    await verify(await DUMMY_HASH_P, plain, ARGON2);
  } catch {
    /* result intentionally ignored */
  }
}
