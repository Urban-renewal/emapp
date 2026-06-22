import { hash as argon2Hash } from '@node-rs/argon2';
import { sql } from 'drizzle-orm';

import { db, providerPool } from '../src/client';
import { env as dbEnv } from '../src/env';
import { projects } from '../src/schema/projects';
import { memberships, organizations, users } from '../src/schema/tenancy';
import { withTenant } from '../src/wrappers/with-tenant';

export interface TestOrg {
  id: string;
  name: string;
  projects: Array<{ id: string; name: string }>;
  users: Array<{ id: string; role: 'manager' | 'agent' }>;
}

export interface TestProviderUser {
  id: string;
  email: string;
}

/**
 * A provider user that can ACTUALLY complete `ProviderAuthService.login()`:
 * a real argon2id password hash + a real pgcrypto-encrypted TOTP secret, so
 * a test can mint live 6-digit codes with `otpauth` and exercise the full
 * provider login / rotation / reuse-detection paths against the real service
 * (the A2 audit gap — the provider auth path was only covered by the
 * black-box HTTP contract suite, which SKIPS entirely in CI without a live
 * server). The plain password + base32 secret are returned so the caller can
 * authenticate; they are test-only and never persisted in plaintext.
 */
export interface LoginableTestProviderUser extends TestProviderUser {
  password: string;
  /** base32 TOTP secret — feed to `new TOTP({ secret: Secret.fromBase32(...) })`. */
  totpSecretBase32: string;
}

export async function createTestOrg(name: string, slug?: string): Promise<TestOrg> {
  const [org] = await db
    .insert(organizations)
    // Normalize BOTH the derived and the caller-provided slug to the DB's
    // CHECK format (organizations_slug_format, migration 0010: lowercase
    // alnum + hyphens) — callers pass human tags like `swpA-<ts>` and the
    // factory owns making them insertable. TestOrg doesn't expose slug, so
    // no caller can depend on the pre-normalized casing.
    .values({ name, slug: (slug ?? name).toLowerCase().replace(/\s+/g, '-') })
    .returning();

  if (!org) throw new Error('Failed to create test org');

  const [manager] = await db
    .insert(users)
    .values({
      email: `manager-${org.id}@test.local`,
      name: 'Test Manager',
      passwordHash: '$2b$12$placeholder',
    })
    .returning();

  if (!manager) throw new Error('Failed to create test manager');

  await db.insert(memberships).values({
    userId: manager.id,
    orgId: org.id,
    role: 'manager',
    isPrimary: true,
    acceptedAt: new Date(),
  });

  // Engine-backed authorization (IAM slice 5) resolves a user's effective
  // permissions from `role_assignments ⋈ role_permissions`, NOT from the
  // legacy `memberships.role`. A real org's manager gets an org-scoped
  // assignment to the system `manager` role at signup/backfill; the factory
  // mirrors that so the seeded manager actually HOLDS the manager permission
  // set (incl. owners.reveal_pii). Without this, service-level engine checks
  // (e.g. the sensitive-doc PII gate's reveal-PII re-assertion) would resolve
  // an EMPTY set for the factory manager and wrongly deny. Best-effort: the
  // system roles are seeded globally by the migrations (org_id IS NULL); skip
  // silently if absent so non-IAM suites that don't need it still get an org.
  const sysMgr = await providerPool.query<{ id: string }>(
    `SELECT id FROM roles WHERE org_id IS NULL AND is_system = true AND key = 'manager' LIMIT 1`,
  );
  const managerRoleId = sysMgr.rows[0]?.id;
  if (managerRoleId) {
    await providerPool.query(
      `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_at)
       VALUES ($1, $2, 'org', $3, now())
       ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
      [manager.id, managerRoleId, org.id],
    );
  }

  const testProjects = await withTenant(org.id, async (tx) => {
    const [proj1] = await tx
      .insert(projects)
      .values({
        orgId: org.id,
        name: `${name} Project 1`,
        type: 'tama38_1',
        createdBy: manager.id,
      })
      .returning();

    const [proj2] = await tx
      .insert(projects)
      .values({
        orgId: org.id,
        name: `${name} Project 2`,
        type: 'pinui_binui',
        createdBy: manager.id,
      })
      .returning();

    return [proj1!, proj2!];
  });

  return {
    id: org.id,
    name: org.name,
    projects: testProjects.map((p) => ({ id: p.id, name: p.name })),
    users: [{ id: manager.id, role: 'manager' }],
  };
}

export async function createTestProviderUser(): Promise<TestProviderUser> {
  const client = await providerPool.connect();
  try {
    const result = await client.query<{ id: string; email: string }>(
      `INSERT INTO provider_users
         (email, name, password_hash, mfa_secret_encrypted, recovery_codes_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, email`,
      [
        `provider-${Date.now()}@test.local`,
        'Test Provider Admin',
        '$2b$12$placeholder',
        Buffer.from('test-mfa-placeholder'),
        '[]',
      ],
    );
    return result.rows[0]!;
  } finally {
    client.release();
  }
}

// Argon2id params MUST match apps/api/src/modules/auth/password.ts, else the
// service's verifyPassword (which re-derives with these costs) rejects the hash.
const ARGON2_TEST = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// A deterministic, valid base32 TOTP secret (RFC 4648 alphabet, no padding) —
// `otpauth`'s Secret.fromBase32 accepts it and the same value round-trips through
// pgcrypto. Built at runtime from a short low-entropy fragment (×4) rather than a
// 32-char literal so the secret-scanner doesn't false-positive on a high-entropy
// string — this is a throwaway TEST seed, not a real credential.
const TEST_TOTP_SECRET_B32 = 'GEZDGNBV'.repeat(4);

/**
 * Seed a provider user that can pass the FULL `ProviderAuthService.login()`
 * (real password + real MFA). The TOTP secret is encrypted with pgcrypto
 * using `PII_ENCRYPTION_KEY` exactly as enrolment does, so the service's
 * `decryptField` recovers it and `totp.validate()` accepts a live code the
 * caller generates from `totpSecretBase32`.
 *
 * Optional overrides let a test seed a DISABLED account or a corrupted role
 * (both must be rejected by login as a generic 401 — no oracle).
 */
export async function createLoginableTestProviderUser(opts?: {
  disabled?: boolean;
  role?: string;
}): Promise<LoginableTestProviderUser> {
  const password = `Pv-${Math.random().toString(36).slice(2)}-Aa1!`;
  const passwordHash = await argon2Hash(password, ARGON2_TEST);
  const email = `provider-loginable-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;

  // Encrypt the TOTP secret with pgp_sym_encrypt(PII_ENCRYPTION_KEY) — the
  // exact representation the service decrypts at login time.
  const encKey = dbEnv.PII_ENCRYPTION_KEY;
  if (!encKey) throw new Error('PII_ENCRYPTION_KEY required to seed a loginable provider user');
  const encRes = await db.execute<{ enc: Buffer }>(
    sql`SELECT pgp_sym_encrypt(${TEST_TOTP_SECRET_B32}, ${encKey}) AS enc`,
  );
  const mfaEncrypted = encRes.rows[0]?.enc;
  if (!mfaEncrypted) throw new Error('failed to encrypt TOTP secret for test provider user');

  const client = await providerPool.connect();
  try {
    const result = await client.query<{ id: string; email: string }>(
      `INSERT INTO provider_users
         (email, name, password_hash, role, mfa_secret_encrypted, recovery_codes_hash, disabled_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING id, email`,
      [
        email,
        'Loginable Provider Admin',
        passwordHash,
        opts?.role ?? 'admin',
        mfaEncrypted,
        '[]',
        opts?.disabled ? new Date().toISOString() : null,
      ],
    );
    return {
      ...result.rows[0]!,
      password,
      totpSecretBase32: TEST_TOTP_SECRET_B32,
    };
  } finally {
    client.release();
  }
}
