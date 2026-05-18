import { hash, verify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet: argon2id, m=19456 KiB, t=2, p=1.
// @node-rs/argon2 defaults algorithm to Argon2id; set explicitly is a const
// enum (blocked by isolatedModules), so we rely on the documented default.
const ARGON2 = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

// A pre-computed argon2id hash of a throwaway value. Verifying against it on
// the unknown-user path keeps login timing ~constant (no user-existence
// timing oracle — Doc07 §6.12.1 anti-enumeration).
let DUMMY_HASH: string | undefined;

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
  if (!DUMMY_HASH) DUMMY_HASH = await hash('constant-time-dummy-secret', ARGON2);
  try {
    await verify(DUMMY_HASH, plain, ARGON2);
  } catch {
    /* result intentionally ignored */
  }
}
