/**
 * P0.C1 — Data-subject rights (ACCESS export + ERASURE / right-to-be-forgotten).
 * Deterministic real-DB. Mirrors the owners-fidelity spec scaffolding.
 *
 * Asserts:
 *   - ACCESS (dataExport) returns the FULL record: decrypted PII + ownerships
 *     (with project/apartment context) + signature events.
 *   - ERASURE anonymizes the PII (crypto-shred) but RETAINS the signature +
 *     ownership rows (legal validity survives, identity redacted).
 *   - ERASURE is IDEMPOTENT (re-erase = no-op, alreadyErased: true).
 *   - An ERASED owner can no longer be revealed (revealPii 404) nor accessed
 *     (dataExport 404) — un-revealable, no oracle.
 *   - Both operations are MANAGER-gated (agent/viewer → 403) and write an
 *     erasure_log compliance row carrying NO PII values.
 */
import { randomUUID } from 'node:crypto';

import {
  auditLog,
  db,
  documents,
  encryptOwnerPii,
  erasureLog,
  owners,
  signatures,
  withTenant,
} from '@emapp/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { DataSubjectService } from './data-subject.service';
import { OwnersService } from './owners.service';

let dsvc: DataSubjectService;
let osvc: OwnersService;
let org: TestOrg;
let managerId: string;
let projectId: string;
let projectName: string;

const PHONE = '+972541239876';
const NAME = 'דייר לבדיקה';
const A_SID = '00000000-0000-4000-8000-0000000000c1';

// Per-test unique national_id (the `owners_org_natid_unique_active` partial
// index rejects a duplicate LIVE national_id in the same org; non-erasing
// tests leave a live owner behind). Any 9-digit string is fine — the service
// does no checksum validation (that lives in the API DTO, not exercised here).
let nidSeq = 100000000;
function nextNid(): string {
  nidSeq += 7;
  return String(nidSeq);
}
let NID: string;

function tok(role: 'manager' | 'agent' | 'viewer', sub = managerId): AccessTokenPayload {
  return { sub, orgId: org.id, role, sid: A_SID, type: 'access' } as unknown as AccessTokenPayload;
}

async function seedBuilding(pid: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city) VALUES ($1, $2, 'TLV') RETURNING id`,
      [pid, `St-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}
async function seedApartment(bid: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number) VALUES ($1, $2) RETURNING id`,
      [bid, randomUUID().slice(0, 8)],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}
async function seedOwner(): Promise<string> {
  return withTenant(org.id, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, { nationalId: NID, name: NAME, phone: PHONE });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId: org.id,
        email: 'subject@test.local',
        notes: 'free-text note with maybe-PII',
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}
// S6a audit-fidelity — seed an owner with an ARBITRARY subset of PII present.
// Mirrors `seedOwner` but lets a test omit name / national_id (V12 3a SHELL
// owner: NULL name_encrypted + NULL national_id_encrypted) while keeping a
// present phone. `encryptOwnerPii` already maps an absent field → NULL
// ciphertext + NULL hash, so the persisted row is a genuine shell.
async function seedOwnerWithPii(pii: {
  name?: string;
  nationalId?: string;
  phone?: string;
}): Promise<string> {
  return withTenant(org.id, async (tx) => {
    const enc = await encryptOwnerPii(tx as never, {
      nationalId: pii.nationalId,
      name: pii.name,
      phone: pii.phone,
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId: org.id,
        email: null,
        notes: null,
        nameEncrypted: enc.nameEncrypted,
        nameHash: enc.nameHash,
        nationalIdEncrypted: enc.nationalIdEncrypted,
        nationalIdHash: enc.nationalIdHash,
        phoneEncrypted: enc.phoneEncrypted,
        phoneHash: enc.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

// Read the persisted `owner.data_exported` audit row's `afterState.revealed`
// for a given owner — the SAME pattern owners-fidelity.spec uses for
// `owner.pii_revealed` (select from auditLog via the app pool, newest row).
async function exportedRevealed(targetId: string): Promise<string[]> {
  const [row] = await db
    .select({ afterState: auditLog.afterState })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, targetId), eq(auditLog.action, 'owner.data_exported')))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  expect(row, 'no owner.data_exported audit row').toBeTruthy();
  return (row!.afterState as { revealed: string[] }).revealed;
}

async function seedOwnership(apartmentId: string, ownerId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct) VALUES ($1, $2, 100.00)`,
      [apartmentId, ownerId],
    );
  } finally {
    c.release();
  }
}
// A recognisable biometric SVG so the post-erase assertion can prove the
// ORIGINAL mark is gone (not merely that the column changed).
const SIG_SVG = '<svg><path d="M10 10 L90 90 biometric-mark"/></svg>';
const SIGNER_IP = '203.0.113.7';
const SIGNER_UA = 'Mozilla/5.0 (erasure-test signer)';

async function seedSignature(ownerId: string): Promise<{ docId: string; sigId: string }> {
  const [doc] = await db
    .insert(documents)
    .values({
      orgId: org.id,
      name: 'consent.pdf',
      type: 'consent',
      mimeType: 'application/pdf',
      sizeBytes: 123,
      r2Key: `r2/${randomUUID()}`,
      contentHash: 'deadbeef',
      uploadedBy: managerId,
      uploadedAt: new Date(),
    })
    .returning({ id: documents.id });
  const [sig] = await db
    .insert(signatures)
    .values({
      orgId: org.id,
      documentId: doc!.id,
      ownerId,
      documentHash: 'sighash-abc',
      signatureBlob: Buffer.from(SIG_SVG),
      signerIp: SIGNER_IP,
      signerUserAgent: SIGNER_UA,
      authMethod: 'otp',
      signedAt: new Date(),
    })
    .returning({ id: signatures.id });
  return { docId: doc!.id, sigId: sig!.id };
}

let ownerId: string;
let apartmentId: string;
let sigId: string;

beforeAll(async () => {
  await setupTestDatabase();
  dsvc = new DataSubjectService();
  osvc = new OwnersService();
  const tag = `dsr-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
  projectName = org.projects[0]!.name;
}, 120_000);

beforeEach(async () => {
  // Fresh owner per test (erasure is destructive + idempotent).
  NID = nextNid();
  ownerId = await seedOwner();
  apartmentId = await seedApartment(await seedBuilding(projectId));
  await seedOwnership(apartmentId, ownerId);
  ({ sigId } = await seedSignature(ownerId));
});

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('ACCESS — right to access (dataExport)', () => {
  it('AX-1) returns the FULL record: decrypted PII + ownerships + signatures', async () => {
    const out = await dsvc.dataExport(tok('manager'), ownerId);
    expect(out.owner.id).toBe(ownerId);
    expect(out.owner.name).toBe(NAME);
    expect(out.owner.nationalId).toBe(NID); // CLEARTEXT (this IS the access response)
    expect(out.owner.phone).toBe(PHONE);
    expect(out.owner.email).toBe('subject@test.local');

    expect(out.ownerships).toHaveLength(1);
    expect(out.ownerships[0]!.apartmentId).toBe(apartmentId);
    expect(out.ownerships[0]!.projectId).toBe(projectId);
    expect(out.ownerships[0]!.projectName).toBe(projectName);
    expect(out.ownerships[0]!.ownershipPct).toBe(100);

    expect(out.signatures).toHaveLength(1);
    expect(out.signatures[0]!.signatureId).toBe(sigId);
    expect(out.signatures[0]!.documentHash).toBe('sighash-abc');
    expect(out.signatures[0]!.documentName).toBe('consent.pdf');
  }, 30_000);

  it('AX-1b) a FULL owner (name+national_id+phone) audits ALL THREE PII fields revealed', async () => {
    // `ownerId` (beforeEach) has all three PII fields present.
    await dsvc.dataExport(tok('manager'), ownerId);
    const revealed = await exportedRevealed(ownerId);
    // Field NAMES only — never the cleartext values (CLAUDE.md / Doc07).
    expect(revealed).toEqual(expect.arrayContaining(['name', 'national_id', 'phone']));
    expect(revealed).toHaveLength(3);
    const blob = JSON.stringify(revealed);
    expect(blob).not.toContain(NID);
    expect(blob).not.toContain(NAME);
    expect(blob).not.toContain(PHONE);
  }, 30_000);

  it('AX-1c) a SHELL owner (NULL name + NULL national_id, present phone) audits ONLY the present field', async () => {
    // V12 3a SHELL — the fidelity contract: the audit must NOT claim name /
    // national_id were revealed when they are absent (NULL ciphertext).
    const shellId = await seedOwnerWithPii({ phone: PHONE });
    await dsvc.dataExport(tok('manager'), shellId);
    const revealed = await exportedRevealed(shellId);
    expect(revealed).toContain('phone');
    expect(revealed).not.toContain('name');
    expect(revealed).not.toContain('national_id');
    expect(revealed).toEqual(['phone']);
  }, 30_000);

  it('AX-1d) a bare SHELL owner (no name / no national_id / no phone) audits an EMPTY revealed set', async () => {
    const bareId = await seedOwnerWithPii({});
    await dsvc.dataExport(tok('manager'), bareId);
    const revealed = await exportedRevealed(bareId);
    expect(revealed).toEqual([]);
  }, 30_000);

  it('AX-2) agent + viewer are DENIED (manager-tier only)', async () => {
    await expect(dsvc.dataExport(tok('agent'), ownerId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(dsvc.dataExport(tok('viewer'), ownerId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('AX-3) unknown owner → 404 (no oracle)', async () => {
    await expect(dsvc.dataExport(tok('manager'), randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ERASURE — right to be forgotten (erase)', () => {
  it('ER-1) crypto-shreds PII but RETAINS the signature + ownership rows', async () => {
    const res = await dsvc.erase(tok('manager'), ownerId, { reason: 'subject request #42' });
    expect(res.alreadyErased).toBe(false);
    expect(res.signaturesRetained).toBe(1);
    expect(res.ownershipsRetained).toBe(1);
    expect(res.clearedFields).toEqual(
      expect.arrayContaining([
        'name',
        'national_id',
        'phone',
        'email',
        'notes',
        // erasure-completeness HIGH #1 — biometric signature redaction.
        'signature_blob',
        'signer_ip',
        'signer_user_agent',
      ]),
    );

    // Row inspection via the BYPASSRLS provider pool (raw truth).
    const c = await providerPool.connect();
    try {
      const r = await c.query<{
        erased_at: Date | null;
        national_id_hash: string | null;
        name_hash: Buffer | null;
        phone_hash: string | null;
        email: string | null;
        notes: string | null;
        nid_plain: string;
        name_plain: string;
      }>(
        `SELECT erased_at, national_id_hash, name_hash, phone_hash, email, notes,
                pgp_sym_decrypt(national_id_encrypted, $2)::text AS nid_plain,
                pgp_sym_decrypt(name_encrypted, $2)::text AS name_plain
           FROM owners WHERE id = $1`,
        [ownerId, process.env.PII_ENCRYPTION_KEY],
      );
      const row = r.rows[0]!;
      expect(row.erased_at).not.toBeNull();
      // HMAC lookup hashes NULLed — un-findable by original value.
      expect(row.national_id_hash).toBeNull();
      expect(row.name_hash).toBeNull();
      expect(row.phone_hash).toBeNull();
      expect(row.email).toBeNull();
      expect(row.notes).toBeNull();
      // PII ciphertext overwritten with the irreversible tombstone (NOT the
      // original PII).
      expect(row.nid_plain).not.toContain(NID);
      expect(row.name_plain).not.toContain(NAME);
      expect(row.nid_plain).toBe('[erased]');

      // Signature + ownership RETAINED in place (anonymize-not-delete).
      const sig = await c.query<{
        id: string;
        blob: Buffer;
        document_hash: string;
        signed_at: Date;
        signer_ip: string | null;
        signer_user_agent: string | null;
      }>(
        `SELECT id, signature_blob AS blob, document_hash, signed_at,
                signer_ip::text AS signer_ip, signer_user_agent
           FROM signatures WHERE id = $1`,
        [sigId],
      );
      expect(sig.rowCount).toBe(1);
      const sigRow = sig.rows[0]!;
      // erasure-completeness HIGH #1 — biometric SVG is GONE: the blob is now
      // the fixed tombstone, NOT the original mark.
      expect(sigRow.blob.toString('utf8')).toBe('[erased]');
      expect(sigRow.blob.toString('utf8')).not.toContain('biometric-mark');
      // Forensic PII-adjacent columns NULLed.
      expect(sigRow.signer_ip).toBeNull();
      expect(sigRow.signer_user_agent).toBeNull();
      // …but the LEGAL PROOF survives: document hash + signed_at + the row link.
      expect(sigRow.document_hash).toBe('sighash-abc');
      expect(sigRow.signed_at).not.toBeNull();

      const own = await c.query(`SELECT id FROM ownerships WHERE owner_id = $1`, [ownerId]);
      expect(own.rowCount).toBe(1);
    } finally {
      c.release();
    }
  }, 30_000);

  it('ER-2) writes an erasure_log row with NO PII values (field names + counts only)', async () => {
    await dsvc.erase(tok('manager'), ownerId, { reason: 'subject request' });
    const rows = await withTenant(org.id, (tx) =>
      tx.select().from(erasureLog).where(eq(erasureLog.ownerId, ownerId)),
    );
    expect(rows).toHaveLength(1);
    const log = rows[0]!;
    expect(log.signaturesRetained).toBe(1);
    expect(log.ownershipsRetained).toBe(1);
    expect(log.clearedFields).toEqual(expect.arrayContaining(['national_id']));
    // Ledger NEVER carries PII values.
    expect(JSON.stringify(log)).not.toContain(NID);
    expect(JSON.stringify(log)).not.toContain(NAME);
    expect(JSON.stringify(log)).not.toContain(PHONE);
  }, 30_000);

  it('ER-3) is IDEMPOTENT — re-erase is a no-op (alreadyErased, no 2nd ledger row)', async () => {
    const first = await dsvc.erase(tok('manager'), ownerId, {});
    expect(first.alreadyErased).toBe(false);
    const second = await dsvc.erase(tok('manager'), ownerId, {});
    expect(second.alreadyErased).toBe(true);
    expect(second.erasedAt.getTime()).toBe(first.erasedAt.getTime());

    const rows = await withTenant(org.id, (tx) =>
      tx.select().from(erasureLog).where(eq(erasureLog.ownerId, ownerId)),
    );
    expect(rows).toHaveLength(1); // exactly one ledger row across two erase calls
  }, 30_000);

  it('ER-4) an ERASED owner is un-revealable (revealPii 404) and un-accessible (dataExport 404)', async () => {
    await dsvc.erase(tok('manager'), ownerId, {});
    await expect(osvc.revealPii(tok('manager'), ownerId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(dsvc.dataExport(tok('manager'), ownerId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  }, 30_000);

  it('ER-5) an ERASED owner drops out of the normal owner list', async () => {
    const before = await osvc.list(tok('manager'), { limit: 100 });
    expect(before.data.map((o) => o.id)).toContain(ownerId);
    await dsvc.erase(tok('manager'), ownerId, {});
    const after = await osvc.list(tok('manager'), { limit: 100 });
    expect(after.data.map((o) => o.id)).not.toContain(ownerId);
  }, 30_000);

  it('ER-6) agent + viewer are DENIED (manager-tier only)', async () => {
    await expect(dsvc.erase(tok('agent'), ownerId, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(dsvc.erase(tok('viewer'), ownerId, {})).rejects.toBeInstanceOf(ForbiddenException);
    // and a denied attempt left the owner intact (no partial erasure).
    const out = await dsvc.dataExport(tok('manager'), ownerId);
    expect(out.owner.nationalId).toBe(NID);
  }, 30_000);
});
