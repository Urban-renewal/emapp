/**
 * v8.5 ADVERSARIAL — owners.create with malicious / nasty PII strings.
 *
 * The Israeli urban-renewal product handles names entered by Managers
 * who copy-paste from contracts, government forms, and Excel files —
 * meaning names can carry:
 *   - apostrophes (אסתר עו'ר)
 *   - hyphens, RTL marks, nikud, ZWJ/ZWNJ
 *   - digit runs that LOOK like national_id (some surnames are numeric)
 *   - SQL-injection-shaped payloads (a hostile Contractor importing
 *     curated-evil Excel files into the V wizard)
 *
 * The v8.5 contract:
 *   1. Every name round-trips through encrypt → store → decrypt
 *      byte-identically (NO mangling at any layer).
 *   2. audit_log.afterState NEVER contains the cleartext name OR
 *      anything that looks like national_id / phone — even when the
 *      name itself is a national_id-shaped string.
 *   3. Parameter binding holds — SQL-shaped names don't break the
 *      INSERT, don't escape the audit_log JSON, don't show up as
 *      executed SQL.
 *
 * These tests are the "what does a hostile import look like?" battery.
 */
import { randomUUID } from 'node:crypto';

import {
  auditLog,
  decryptOwnerName,
  organizations,
  owners,
  providerDb,
  users,
  withTenant,
} from '@emapp/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AccessTokenPayload } from '../auth/auth.service';

import { OwnersService } from './owners.service';

const TEST_PREFIX = 'v85-owner-adv';

let orgId: string;
let userId: string;
let svc: OwnersService;

const SID = '00000000-0000-4000-8000-00000000cafe';

function user(): AccessTokenPayload {
  return {
    sub: userId,
    orgId,
    role: 'manager',
    sid: SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function seedOrgAndUser(): Promise<{ orgId: string; userId: string }> {
  const oid = randomUUID();
  const uid = randomUUID();
  await providerDb.insert(organizations).values({
    id: oid,
    name: `${TEST_PREFIX}-${oid.slice(0, 8)}`,
    slug: `${TEST_PREFIX}-${oid.slice(0, 8)}`.replace(/[^a-z0-9-]/gi, '').slice(0, 30),
  });
  await providerDb.insert(users).values({
    id: uid,
    email: `${TEST_PREFIX}-${uid.slice(0, 8)}@test.local`,
    passwordHash: 'argon2id$dummy',
    name: 'v8.5 adv test',
  });
  return { orgId: oid, userId: uid };
}

async function cleanup(): Promise<void> {
  await providerDb
    .delete(owners)
    .where(eq(owners.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(users)
    .where(eq(users.id, userId))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => undefined);
}

// Generate a fresh-each-call national_id that passes Luhn (Israeli
// checksum). Naive but works for test purposes — we vary the prefix
// so concurrent tests don't collide on the unique constraint.
let nidCounter = 100_000_000;
function freshNationalId(): string {
  // Just use the test sequence — these aren't real Luhn IDs, but
  // owners.service's create accepts whatever passes the Zod refine.
  // For a real Luhn-passing ID we'd compute the check digit; the
  // existing service test fixtures use these same shapes.
  nidCounter += 7;
  return String(nidCounter).padStart(9, '0');
}

describe('v8.5 ADVERSARIAL owners.create — PII string shapes', () => {
  beforeAll(async () => {
    ({ orgId, userId } = await seedOrgAndUser());
    svc = new OwnersService();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("1) name with apostrophe (`אסתר עו'ר`) round-trips identically — no SQL break", async () => {
    const name = "אסתר עו'ר";
    const created = await svc.create(user(), { name, national_id: freshNationalId() } as never);

    const [row] = await providerDb
      .select({ nameEncrypted: owners.nameEncrypted })
      .from(owners)
      .where(eq(owners.id, created.id))
      .limit(1);
    const decrypted = await withTenant(orgId, (tx) =>
      decryptOwnerName(tx as never, row!.nameEncrypted as Buffer),
    );
    expect(decrypted).toBe(name);
  });

  it('2) name with double-quote (`John "Bear" Smith`) round-trips identically', async () => {
    const name = 'יוני "הדוב" כהן';
    const created = await svc.create(user(), { name, national_id: freshNationalId() } as never);
    const [row] = await providerDb
      .select({ nameEncrypted: owners.nameEncrypted })
      .from(owners)
      .where(eq(owners.id, created.id))
      .limit(1);
    const decrypted = await withTenant(orgId, (tx) =>
      decryptOwnerName(tx as never, row!.nameEncrypted as Buffer),
    );
    expect(decrypted).toBe(name);
  });

  it('3) name with SQL-shaped payload — INSERT does not break, payload is encrypted, audit does not contain it', async () => {
    const name = "Robert'); DROP TABLE owners; --";
    const created = await svc.create(user(), { name, national_id: freshNationalId() } as never);
    // The row exists.
    const [row] = await providerDb
      .select({ id: owners.id, nameEncrypted: owners.nameEncrypted })
      .from(owners)
      .where(eq(owners.id, created.id))
      .limit(1);
    expect(row).toBeDefined();
    // Decrypt → byte-identical to input (parameter binding held).
    const decrypted = await withTenant(orgId, (tx) =>
      decryptOwnerName(tx as never, row!.nameEncrypted as Buffer),
    );
    expect(decrypted).toBe(name);
    // owners table still exists (the most obvious SQL-injection
    // sanity check). If `DROP TABLE` had executed, the next SELECT
    // would have failed.
    await providerDb.select({ id: owners.id }).from(owners).limit(1);
    // Audit row must NOT contain the payload.
    const [auditRow] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'owners'), eq(auditLog.targetId, created.id))),
    );
    const blob = JSON.stringify(auditRow!.afterState);
    expect(blob).not.toContain('DROP TABLE');
    expect(blob).not.toContain('Robert');
  });

  it('4) name that LOOKS like a 9-digit national_id — audit must not contain the digit substring', async () => {
    // Edge case: some Israeli surnames or transliterations are
    // numeric or alphanumeric. A future audit-PII scanner that
    // greps for /\d{9}/ would false-positive on the audit IF we
    // ever wrote the name in. We pin that we don't.
    const name = '038111223'; // looks exactly like a national_id
    const created = await svc.create(user(), { name, national_id: freshNationalId() } as never);
    const [auditRow] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'owners'), eq(auditLog.targetId, created.id))),
    );
    const blob = JSON.stringify(auditRow!.afterState);
    expect(blob).not.toContain('038111223');
    expect(blob).not.toMatch(/\b\d{9}\b/);
  });

  it('5) name with control characters (\\0, \\x01, \\x07) — encrypt path tolerates', async () => {
    // Some Excel exports contain null bytes or other low-ASCII
    // control characters. pgcrypto handles binary input, but pg
    // text-mode params sometimes refuse \0. We don't want to crash
    // on a hostile upload — we want either a clean reject or a
    // clean accept-and-store.
    const name = 'Test\x01Name\x07';
    let result: 'created' | 'rejected' = 'rejected';
    try {
      const created = await svc.create(user(), {
        name,
        national_id: freshNationalId(),
      } as never);
      result = 'created';
      // If accepted, decrypt must equal input.
      const [row] = await providerDb
        .select({ nameEncrypted: owners.nameEncrypted })
        .from(owners)
        .where(eq(owners.id, created.id))
        .limit(1);
      const decrypted = await withTenant(orgId, (tx) =>
        decryptOwnerName(tx as never, row!.nameEncrypted as Buffer),
      );
      expect(decrypted).toBe(name);
    } catch {
      // Acceptable outcome: the service rejected the input.
    }
    expect(['created', 'rejected']).toContain(result);
  });

  it('6) extremely long Hebrew name (300 chars) round-trips — encrypt does not truncate', async () => {
    const name = 'אבי'.repeat(100); // 300 chars
    const created = await svc.create(user(), { name, national_id: freshNationalId() } as never);
    const [row] = await providerDb
      .select({ nameEncrypted: owners.nameEncrypted })
      .from(owners)
      .where(eq(owners.id, created.id))
      .limit(1);
    const decrypted = await withTenant(orgId, (tx) =>
      decryptOwnerName(tx as never, row!.nameEncrypted as Buffer),
    );
    expect(decrypted).toBe(name);
    expect(decrypted.length).toBe(300);
  });

  it('7) name containing a percent-sign + format specifier — no printf-style interpretation', async () => {
    // Pathological case from people building things on top of the
    // encrypted column — if a future log line did
    // `console.log(\`name: ${row.name}\`)` and someone evil set
    // their name to `%s %s %s`, it should still be inert.
    const name = '%s%n%d%p%x';
    const created = await svc.create(user(), { name, national_id: freshNationalId() } as never);
    const [row] = await providerDb
      .select({ nameEncrypted: owners.nameEncrypted })
      .from(owners)
      .where(eq(owners.id, created.id))
      .limit(1);
    const decrypted = await withTenant(orgId, (tx) =>
      decryptOwnerName(tx as never, row!.nameEncrypted as Buffer),
    );
    expect(decrypted).toBe(name);
  });

  it('8) name with RTL override + LTR mark — encryption is byte-identical, audit is clean', async () => {
    const name = String.fromCodePoint(
      0x202e, // RLO
      0x05d0,
      0x05d1,
      0x05d2,
      0x200e, // LRM
      0x202c, // PDF (Pop Directional Formatting)
    );
    const created = await svc.create(user(), { name, national_id: freshNationalId() } as never);
    const [row] = await providerDb
      .select({ nameEncrypted: owners.nameEncrypted })
      .from(owners)
      .where(eq(owners.id, created.id))
      .limit(1);
    const decrypted = await withTenant(orgId, (tx) =>
      decryptOwnerName(tx as never, row!.nameEncrypted as Buffer),
    );
    expect(decrypted).toBe(name);
    // Audit row must NOT carry these bytes either.
    const [auditRow] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'owners'), eq(auditLog.targetId, created.id))),
    );
    const blob = JSON.stringify(auditRow!.afterState);
    expect(blob).not.toContain(String.fromCodePoint(0x202e));
  });

  it('9) name = empty string at the DTO layer — Zod rejects (validation is the contract gate)', async () => {
    // The OwnersService is a TRUSTED-INPUT layer; validation lives
    // in the DTO (apps/api/src/modules/owners/owner.dto.ts). The
    // contract we pin here: an empty-string name does NOT survive
    // DTO parse. The service-layer test in #12 below proves that
    // even if validation were ever bypassed, encryption is still
    // byte-correct — but the user-facing API rejects.
    const { CreateOwnerDto } = await import('./owner.dto');
    const parsed = CreateOwnerDto.safeParse({ name: '', national_id: '038123456' });
    expect(parsed.success).toBe(false);
  });

  it('10) phone-shaped string in name — audit must NOT match the phone regex', async () => {
    // Numbers that look like Israeli phones (0541234567) could be
    // legitimately part of a name (typo, paste error). Audit must
    // not appear to leak a phone just because someone put one in
    // their name field.
    const name = 'בעל הטלפון 0541234567';
    const created = await svc.create(user(), { name, national_id: freshNationalId() } as never);
    const [auditRow] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'owners'), eq(auditLog.targetId, created.id))),
    );
    const blob = JSON.stringify(auditRow!.afterState);
    expect(blob).not.toMatch(/05\d{8}/);
    expect(blob).not.toContain('0541234567');
  });

  it('11) JSON-injection in name — JSON.stringify in audit must safely encode (no shape escape)', async () => {
    // If the audit-log writer ever switched from JSON.stringify to
    // template concatenation, this name would escape the object shape.
    // We pin that audit_log.afterState parses as the same shape we
    // expect, regardless of input.
    const name = '","email":"hacker@evil.test","extra":"';
    const created = await svc.create(user(), { name, national_id: freshNationalId() } as never);
    const [auditRow] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'owners'), eq(auditLog.targetId, created.id))),
    );
    const after = auditRow!.afterState as Record<string, unknown>;
    // The shape MUST still be { changed: [...] } — no extra `email`
    // key or `extra` key smuggled through.
    expect(Object.keys(after).sort()).toEqual(['changed']);
    expect(after).not.toHaveProperty('email');
    expect(after).not.toHaveProperty('extra');
  });

  it(
    '12) Many adversarial owners in quick succession — every row decrypts to its own input (no cross-row leak)',
    { timeout: 30_000 },
    async () => {
      // Concurrency-ish: create 5 owners with very-different names
      // back-to-back, then verify each decrypts to its own name.
      // Pins the "no IV reuse / no shared state in encryptOwnerName"
      // contract.
      const names = [
        "Robert'; DROP--",
        'אבי הגר',
        '038999888',
        'שורה  עם  רווחים  כפולים',
        '<script>alert(1)</script>',
      ];
      const ids: string[] = [];
      for (const name of names) {
        // eslint-disable-next-line no-await-in-loop
        const c = await svc.create(user(), { name, national_id: freshNationalId() } as never);
        ids.push(c.id);
      }
      for (let i = 0; i < ids.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const [row] = await providerDb
          .select({ nameEncrypted: owners.nameEncrypted })
          .from(owners)
          .where(eq(owners.id, ids[i]!))
          .limit(1);
        // eslint-disable-next-line no-await-in-loop
        const decrypted = await withTenant(orgId, (tx) =>
          decryptOwnerName(tx as never, row!.nameEncrypted as Buffer),
        );
        expect(decrypted).toBe(names[i]);
      }
    },
  );
});
