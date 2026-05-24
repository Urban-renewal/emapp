/**
 * v8.5 P0 (Audit Perf F1+F2 — concrete bug): pins the contract of
 * SignatureRequestsService.loadOwnerWithPii, which collapsed
 * 3 sequential round-trips into a single in-SQL SELECT with
 * pgp_sym_decrypt + CASE WHEN. Pre-v8.5 was correct but slow;
 * post-v8.5 must be correct AND fast.
 *
 * These tests pin BEHAVIOUR (the wire shape consumers depend on),
 * not implementation. If a future hand reverts to the 3-query path
 * or breaks the CASE WHEN (e.g. doesn't handle phone=NULL), this
 * spec fails loud.
 *
 * loadOwnerWithPii is private — we reach it via bracket access, the
 * same TypeScript-private/runtime-public pattern that imports-sse-
 * cap.spec.ts uses for activeStreams. The private modifier is a
 * compile-time hint, not a runtime barrier; this is OK for tests.
 */
import { randomUUID } from 'node:crypto';

import { encryptOwnerPii, organizations, owners, providerDb, withTenant } from '@emapp/db';
import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SignatureRequestsService } from './signature-requests.service';

interface LoadResult {
  id: string;
  name: string;
  email: string | null;
  phonePlain: string | null;
  archivedAt: Date | null;
}

/** Reach the private method via bracket access. The double-cast
 *  is the same shape imports-sse-cap.spec.ts uses for activeStreams. */
function loadOwner(
  svc: SignatureRequestsService,
  tx: unknown,
  ownerId: string,
): Promise<LoadResult> {
  return (
    svc as unknown as {
      loadOwnerWithPii: (tx: unknown, ownerId: string) => Promise<LoadResult>;
    }
  ).loadOwnerWithPii(tx, ownerId);
}

const TEST_PREFIX = 'v85-load-pii';

let orgId: string;

async function ensureOrg(): Promise<string> {
  const id = randomUUID();
  await providerDb.insert(organizations).values({
    id,
    name: `${TEST_PREFIX}-${id.slice(0, 8)}`,
    slug: `${TEST_PREFIX}-${id.slice(0, 8)}`.replace(/[^a-z0-9-]/gi, '').slice(0, 30),
  });
  return id;
}

async function dropOrg(id: string): Promise<void> {
  await providerDb
    .delete(owners)
    .where(eq(owners.orgId, id))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, id))
    .catch(() => undefined);
}

async function seedOwner(input: {
  name: string;
  nationalId: string;
  phone?: string;
  email?: string | null;
  archived?: boolean;
}): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: input.nationalId,
      name: input.name,
      ...(input.phone ? { phone: input.phone } : {}),
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        email: input.email ?? null,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
        ...(input.archived ? { archivedAt: new Date() } : {}),
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

describe('v8.5 SignatureRequestsService.loadOwnerWithPii — single-query in-SQL decrypt', () => {
  let svc: SignatureRequestsService;

  beforeAll(async () => {
    orgId = await ensureOrg();
    // Construct with stub deps — only loadOwnerWithPii is exercised
    // here; it doesn't touch email/tokenService.
    svc = new SignatureRequestsService(
      undefined as never, // emailProvider
      undefined as never, // tokenService
    );
  });

  afterAll(async () => {
    await dropOrg(orgId);
  });

  it('1) owner with name + phone + email → returns decrypted name + phonePlain + email passthrough', async () => {
    const name = 'דנה כהן';
    const phone = '0541234567';
    const email = 'dana.k@example.test';
    const ownerId = await seedOwner({
      name,
      nationalId: '038123456',
      phone,
      email,
    });

    const out = await withTenant(orgId, (tx) => loadOwner(svc, tx, ownerId));

    expect(out.id).toBe(ownerId);
    expect(out.name).toBe(name);
    expect(out.phonePlain).toBe(phone);
    expect(out.email).toBe(email);
    expect(out.archivedAt).toBeNull();
  });

  it('2) owner WITHOUT phone → phonePlain is null (CASE WHEN handles NULL correctly)', async () => {
    // The bug this guards: if the v8.5 SQL collapse changed CASE
    // WHEN to an unconditional pgp_sym_decrypt(NULL, key) it would
    // either throw or return an unhelpful value. The contract is
    // phonePlain === null for owners with no phone.
    const ownerId = await seedOwner({
      name: 'אורי בלי טלפון',
      nationalId: '038123457',
      // no phone
    });

    const out = await withTenant(orgId, (tx) => loadOwner(svc, tx, ownerId));
    expect(out.phonePlain).toBeNull();
    expect(out.name).toBe('אורי בלי טלפון');
  });

  it('3) owner without email → email is null', async () => {
    const ownerId = await seedOwner({
      name: 'יוסי בלי אימייל',
      nationalId: '038123458',
      phone: '0529876543',
      email: null,
    });
    const out = await withTenant(orgId, (tx) => loadOwner(svc, tx, ownerId));
    expect(out.email).toBeNull();
    expect(out.phonePlain).toBe('0529876543');
  });

  it('4) archived owner → throws NotFoundException (no PII leak via 200 with archived flag)', async () => {
    const ownerId = await seedOwner({
      name: 'בארכיון',
      nationalId: '038123459',
      archived: true,
    });
    await expect(withTenant(orgId, (tx) => loadOwner(svc, tx, ownerId))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('5) non-existent ownerId → throws NotFoundException (no row leak / no oracle)', async () => {
    await expect(
      withTenant(orgId, (tx) => loadOwner(svc, tx, randomUUID())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('6) Hebrew name with combining marks round-trips byte-identically (no UTF-8 corruption in pgcrypto)', async () => {
    // Test the harder character set — RTL marks + nikud — that some
    // SQL marshallers have silently mangled before. Constructed via
    // code-points to avoid lint's trojan-source/bidi-character flag
    // (false positive — this is a TEST FOR exactly this character
    // class, not a Trojan attack vector).
    // eslint-disable-next-line security/detect-bidi-characters -- deliberate test input
    const name = String.fromCodePoint(
      0x05d0,
      0x05b2,
      0x05d1,
      0x05b4,
      0x05d9,
      0x05d2,
      0x05b7,
      0x05d9,
      0x05b4,
      0x05dc,
      0x200e, // LRM mark — the codepoint that triggers the bidi lint
      0x05dc,
      0x05b5,
      0x05d5,
      0x05b4,
      0x05d9,
    );
    const ownerId = await seedOwner({
      name,
      nationalId: '038123460',
      phone: '0501112233',
    });
    const out = await withTenant(orgId, (tx) => loadOwner(svc, tx, ownerId));
    expect(out.name).toBe(name);
  });

  it('7) phone with leading zero is preserved (a String column round-trip — pgcrypto on TEXT)', async () => {
    // Israeli phones must start with 0; if pgcrypto/text coercion
    // ever lost the leading zero (or some future hand stored the
    // phone as INT), the wa.me link would be unusable.
    const phone = '0521234567';
    const ownerId = await seedOwner({
      name: 'בלי לאבד אפס',
      nationalId: '038123461',
      phone,
    });
    const out = await withTenant(orgId, (tx) => loadOwner(svc, tx, ownerId));
    expect(out.phonePlain).toBe(phone);
    expect(out.phonePlain?.startsWith('0')).toBe(true);
  });

  it('8) structural — no decryptField helper is imported by signature-requests.service.ts (regression guard for the 3-RT path)', async () => {
    // Direct latency assertions flake on Neon developer-tier
    // network jitter (a single round-trip there is ~300-600ms
    // baseline, dominated by the withTenant BEGIN+GUC setup, not
    // by decryption). Instead pin the STRUCTURAL invariant: the
    // service must not pull `decryptField` from `@emapp/db` —
    // that was the helper the 3-round-trip path called twice.
    // If a future hand re-adds it, this fails loud, even if the
    // network happens to be fast on that day.
    //
    // We read the source file's import block (deterministic, no
    // network) so the assertion is robust on any Neon tier.
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const here = url.fileURLToPath(import.meta.url);
    const src = await fs.readFile(
      here.replace(/load-owner-with-pii\.spec\.ts$/, 'signature-requests.service.ts'),
      'utf8',
    );
    // Grab everything before the first non-import line. Strip the
    // file-level comment header so a future hand who DOCUMENTS
    // the old helper in a comment doesn't trip this guard.
    const lines = src.split('\n');
    let endOfImports = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
      const ln = lines[i] ?? '';
      // The first non-comment, non-blank, non-import line ends the import block.
      if (
        ln.trim().length > 0 &&
        !ln.trim().startsWith('//') &&
        !ln.trim().startsWith('/*') &&
        !ln.trim().startsWith('*') &&
        !ln.trim().startsWith('import') &&
        !ln.trim().startsWith('}')
      ) {
        endOfImports = i;
        break;
      }
    }
    const importBlock = lines.slice(0, endOfImports).join('\n');
    expect(importBlock).not.toMatch(/\bdecryptField\b/);
  });

  it('A1) ADVERSARIAL — corrupted ciphertext (one byte flipped) → throws, never returns silent garbage', async () => {
    // The worst-case PII silent corruption: an encrypted column gets
    // a bit-flip from disk error / replication lag, and on read we
    // either get garbled bytes returned to the wire OR pgcrypto
    // throws. Either way must NOT be "200 OK with corrupted name."
    const ownerId = await seedOwner({
      name: 'בדיקת השחתה',
      nationalId: '038123464',
    });
    // Read the encrypted blob, flip a byte, write it back via the
    // BYPASSRLS pool.
    const [pre] = await providerDb
      .select({ nameEncrypted: owners.nameEncrypted })
      .from(owners)
      .where(eq(owners.id, ownerId))
      .limit(1);
    const corrupted = Buffer.from(pre!.nameEncrypted as Buffer);
    // Flip the middle byte (skipping pgcrypto's framing header at
    // the start — flipping there could cause early reject; mid-
    // ciphertext flip exercises the integrity check).
    const mid = Math.floor(corrupted.length / 2);
    corrupted[mid] = corrupted[mid]! ^ 0xff;
    await providerDb.update(owners).set({ nameEncrypted: corrupted }).where(eq(owners.id, ownerId));

    // Now call loadOwnerWithPii — must throw, not silently return.
    await expect(withTenant(orgId, (tx) => loadOwner(svc, tx, ownerId))).rejects.toThrow();
  });

  it('A2) ADVERSARIAL — ciphertext truncated to 1 byte → throws (no silent return of "")', async () => {
    const ownerId = await seedOwner({
      name: 'מקוטע',
      nationalId: '038123465',
    });
    // Truncate to a single byte — pgp_sym_decrypt should refuse.
    await providerDb
      .update(owners)
      .set({ nameEncrypted: Buffer.from([0x00]) })
      .where(eq(owners.id, ownerId));
    await expect(withTenant(orgId, (tx) => loadOwner(svc, tx, ownerId))).rejects.toThrow();
  });

  it('A3) ADVERSARIAL — encrypted with a DIFFERENT key (rotation mid-flight scenario) → throws, no garbage', async () => {
    // If a future deploy rotates PII_ENCRYPTION_KEY mid-flight,
    // any owner row encrypted with the OLD key becomes
    // undecryptable with the NEW key. Behaviour MUST be loud-fail,
    // not "200 with empty/garbage name field on the signature link."
    const ownerId = await seedOwner({
      name: 'מפתח אחר',
      nationalId: '038123466',
    });
    // Encrypt the same plaintext with a wrong key (simulate rotation)
    // via the BYPASSRLS pool, then overwrite the row's ciphertext.
    const { pool } = await import('../../../../../packages/db/src/client');
    const client = await pool.connect();
    let blob: Buffer;
    try {
      const r = await client.query<{ enc: Buffer }>(
        "SELECT pgp_sym_encrypt('whatever', $1) AS enc",
        ['X'.repeat(44)],
      );
      blob = r.rows[0]!.enc;
    } finally {
      client.release();
    }
    await providerDb.update(owners).set({ nameEncrypted: blob }).where(eq(owners.id, ownerId));
    await expect(withTenant(orgId, (tx) => loadOwner(svc, tx, ownerId))).rejects.toThrow();
  });

  it('9) ciphertext on disk is NOT plaintext (defense-in-depth — confirms encrypt path actually encrypts)', async () => {
    const name = 'הסוד הגדול';
    const ownerId = await seedOwner({
      name,
      nationalId: '038123463',
    });
    // Read the encrypted bytea directly (BYPASSRLS via providerDb).
    const [row] = await providerDb
      .select({ nameEncrypted: owners.nameEncrypted })
      .from(owners)
      .where(eq(owners.id, ownerId))
      .limit(1);
    const blob = row!.nameEncrypted as unknown as Buffer;
    expect(blob.length).toBeGreaterThan(0);
    // The plaintext bytes must not appear inside the ciphertext.
    expect(blob.includes(Buffer.from(name, 'utf8'))).toBe(false);
  });
});
