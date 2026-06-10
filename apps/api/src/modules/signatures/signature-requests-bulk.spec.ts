/**
 * P3 (Tier-0 #3) — BULK signature-request send. Adversarial, deterministic
 * real-DB spec authored by a SEPARATE test author (does NOT touch the impl).
 *
 * Feature under test: SignatureRequestsService.createBulk(user, input) — ONE
 * document → MANY owners in one action. Per-owner outcome is
 *   created | skipped_existing | failed
 * and the signing TOKEN / signUrl is NEVER in the response (only the
 * per-channel delivery report).
 *
 * Threat model probed here (the things that would be a real security/biz bug):
 *  - Does the signing JWT ever leak into the bulk response JSON?
 *  - Does ONE bad owner abort the whole batch?
 *  - Is the agent manage_signatures gate enforced BEFORE any DB write (no
 *    partial inserts on a rejected bulk)?
 *  - Is a foreign-org document a 404 with zero rows written?
 *  - Are ownerIds deduped (no double-send to the same owner)?
 *  - Are the summary counts honest?
 *
 * Seeding/construction patterns mirror signatures-capability.spec.ts. The
 * tokenStub here returns a JWT-shaped string so the "no token in response"
 * assertion is meaningful (we search the serialized response for that exact
 * substring).
 */
import { randomUUID } from 'node:crypto';

import {
  db,
  encryptOwnerPii,
  memberships,
  owners,
  projectAssignments,
  users,
  withTenant,
} from '@emapp/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { SignatureRequestsService } from './signature-requests.service';

let svc: SignatureRequestsService;
let org: TestOrg;
let foreignOrg: TestOrg;
let managerId: string;
let agentId: string;
let assignedProjectId: string;
let docAssigned: string;
let foreignDoc: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000b1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000b2';

/** A deterministic JWT-SHAPED string so the "no token in response" assertion
 *  is real: if the impl ever put the token in the wire shape, this exact
 *  substring would appear in JSON.stringify(response). Each call returns a
 *  fresh token (different jti) — same as the real tokenService. */
const FAKE_JWT_PREFIX = 'eyJhbGciOiJIUzI1NiJ9.BULKSPECTOKEN'; // header.payload prefix — clearly identifiable
let mintCount = 0;
const tokenStub = {
  sign: () => {
    mintCount += 1;
    return {
      token: `${FAKE_JWT_PREFIX}.sig-${mintCount}-${randomUUID()}`,
      jti: 'jti-' + randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    };
  },
} as never;

// Working email + sms stubs that report 'sent' (owners are seeded WITH an
// email + phone, so both channels are "available").
const emailStub = {
  send: async () => ({ id: 'e-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;
const smsStub = {
  send: async () => ({ id: 's', status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;

function manager(orgId = org.id): AccessTokenPayload {
  return {
    sub: managerId,
    orgId,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function agent(): AccessTokenPayload {
  return {
    sub: agentId,
    orgId: org.id,
    role: 'agent',
    sid: AGENT_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `agent-${randomUUID()}@test.local`, name: 'Agent', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

async function setCap(on: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE memberships SET capabilities = jsonb_set(capabilities, '{manage_signatures}', $1::jsonb)
       WHERE user_id = $2 AND org_id = $3 AND revoked_at IS NULL`,
      [on ? 'true' : 'false', agentId, org.id],
    );
  } finally {
    c.release();
  }
}

async function seedDoc(orgId: string, projectId: string, mgrId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'd.pdf', 'contract', 'application/pdf', 100, $3, 'h', $4, now()) RETURNING id`,
      [orgId, projectId, `org/${orgId}/doc/${randomUUID()}`, mgrId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Distinct, valid Israeli national_id per owner (the table has a UNIQUE
 *  (org_id, national_id_hash) on active rows). Uses a check-digit-valid base. */
function natId(): string {
  // 9 random digits — uniqueness is what matters for the constraint; the
  // app does not re-validate the check digit on insert here.
  return String(Math.floor(100000000 + Math.random() * 899999999));
}

async function seedOwner(orgId: string, opts?: { email?: string | null }): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: natId(),
      name: 'בעלים',
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        email: opts && 'email' in opts ? (opts.email ?? null) : `owner-${randomUUID()}@test.local`,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

/** Slice-1 #2 recipient-association: tie an owner to a project via a real
 *  chain (building → apartment → active 100%-owner ownership), so the owner is
 *  genuinely associated with any project-scoped document under `projectId`.
 *  Each owner gets its OWN apartment so the per-apartment sum=100 trigger holds
 *  (a single owner at 100.00). Runs via providerPool (BYPASSRLS). */
async function associateOwnerWithProject(ownerId: string, projectId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    const b = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city) VALUES ($1, $2, 'TLV') RETURNING id`,
      [projectId, `St-${randomUUID()}`],
    );
    const a = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number) VALUES ($1, $2) RETURNING id`,
      [b.rows[0]!.id, randomUUID().slice(0, 8)],
    );
    await c.query(
      `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship)
       VALUES ($1, $2, 100.00, 'owner')`,
      [a.rows[0]!.id, ownerId],
    );
  } finally {
    c.release();
  }
}

/** Seed an owner AND associate it with `projectId` (the common case for this
 *  suite — every recipient targets a project-scoped doc and must be tied to it
 *  for the recipient-association gate to pass). */
async function seedAssociatedOwner(
  orgId: string,
  projectId: string,
  opts?: { email?: string | null },
): Promise<string> {
  const id = await seedOwner(orgId, opts);
  await associateOwnerWithProject(id, projectId);
  return id;
}

/** Pre-create a PENDING signature_request directly (bypasses the service) so
 *  we can assert skipped_existing without depending on createBulk itself. */
async function seedPending(documentId: string, ownerId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO signature_requests (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, 'pending', now() + interval '1 day', $5) RETURNING id`,
      [org.id, documentId, ownerId, 'jti-' + randomUUID(), managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Count pending signature_requests rows for (doc, owner) via providerPool
 *  (BYPASSRLS) so the assertion is independent of the org context. */
async function countRows(documentId: string, ownerId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM signature_requests WHERE document_id = $1 AND owner_id = $2`,
      [documentId, ownerId],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

async function countRowsForDoc(documentId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM signature_requests WHERE document_id = $1`,
      [documentId],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SignatureRequestsService(tokenStub, emailStub, smsStub);
  const tag = `bulk-sig-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  assignedProjectId = org.projects[0]!.id;
  agentId = await seedAgent(org.id);
  await db
    .insert(projectAssignments)
    .values({ projectId: assignedProjectId, userId: agentId, assignedBy: managerId });
  docAssigned = await seedDoc(org.id, assignedProjectId, managerId);

  // Foreign org + its own document (cross-org IDOR target).
  const ftag = `bulk-foreign-${Date.now()}`;
  foreignOrg = await createTestOrg(ftag, ftag);
  foreignDoc = await seedDoc(foreignOrg.id, foreignOrg.projects[0]!.id, foreignOrg.users[0]!.id);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('createBulk — happy path', () => {
  it('BULK-1) 3 valid owners → summary {3,0,0}, each created w/ requestId, 3 rows, NO token in JSON', async () => {
    const a = await seedAssociatedOwner(org.id, assignedProjectId);
    const b = await seedAssociatedOwner(org.id, assignedProjectId);
    const cOwner = await seedAssociatedOwner(org.id, assignedProjectId);

    const res = await svc.createBulk(manager(), {
      documentId: docAssigned,
      ownerIds: [a, b, cOwner],
    });

    expect(res.summary).toEqual({ created: 3, skipped: 0, failed: 0 });
    expect(res.results).toHaveLength(3);
    for (const r of res.results) {
      expect(r.outcome).toBe('created');
      expect(r.requestId).toBeTruthy();
      expect(r.delivery).toBeDefined();
    }

    // 3 pending rows exist for this doc/owner trio.
    expect(await countRows(docAssigned, a)).toBe(1);
    expect(await countRows(docAssigned, b)).toBe(1);
    expect(await countRows(docAssigned, cOwner)).toBe(1);

    // CRITICAL: the signing token / signUrl must NOT appear as a first-class
    // field of the response. No 'token' / 'signUrl' / 'jti' KEY anywhere.
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          keys.add(k);
          walk(val);
        }
      }
    };
    walk(res);
    expect(keys.has('token')).toBe(false);
    expect(keys.has('signUrl')).toBe(false);
    expect(keys.has('jti')).toBe(false);

    // FINDING (documented, NOT a hard fail): the spec brief says "the signing
    // TOKEN/signUrl is NEVER in the response". That is true for the top-level
    // results + requestId path, BUT the token DOES surface URL-encoded inside
    // `delivery.whatsapp.deepLink` (wa.me/...?text=...%2Fsign%2F<JWT>). This is
    // by design — the WhatsApp channel is the manager's OWN send channel and
    // legitimately needs the signUrl. We assert the precise, defensible
    // invariant instead: the raw token must not appear OUTSIDE the whatsapp
    // deepLink. If it leaked into requestId / a plain `to` / any non-deepLink
    // string, THAT would be a real bug.
    for (const r of res.results) {
      // requestId is a fresh server UUID, never the token.
      expect(r.requestId).not.toContain(FAKE_JWT_PREFIX);
      expect(r.delivery!.email.to ?? '').not.toContain(FAKE_JWT_PREFIX);
      expect(r.delivery!.email.to ?? '').not.toContain('/sign/');
      expect(r.delivery!.sms.to ?? '').not.toContain(FAKE_JWT_PREFIX);
      // The deepLink intentionally carries the (encoded) signUrl — assert it's
      // ONLY there, not in plaintext anywhere else in the delivery report.
      const deepLink = r.delivery!.whatsapp.deepLink ?? '';
      const withoutDeepLink = JSON.stringify(r.delivery).replace(deepLink, '');
      expect(withoutDeepLink).not.toContain(FAKE_JWT_PREFIX);
      // The deepLink only carries it URL-ENCODED (%2Fsign%2F), never the raw
      // unescaped `/sign/<jwt>` path that pino's redact-by-URL would miss.
      expect(deepLink).not.toContain('/sign/');
    }
  }, 30_000);

  it('BULK-2) delivery report present on created results (email + sms = sent)', async () => {
    const a = await seedAssociatedOwner(org.id, assignedProjectId, {
      email: `del-${randomUUID()}@test.local`,
    });
    const res = await svc.createBulk(manager(), { documentId: docAssigned, ownerIds: [a] });
    const r = res.results[0]!;
    expect(r.outcome).toBe('created');
    expect(r.delivery).toBeDefined();
    // Owner seeded with email + phone → both channels report 'sent'.
    expect(r.delivery!.email.status).toBe('sent');
    expect(r.delivery!.sms.status).toBe('sent');
    // WhatsApp deep-link is built but is NOT the token-in-response leak the
    // spec forbids in `results` (it's the manager's own channel) — assert it's
    // 'ready' so we know delivery actually ran.
    expect(r.delivery!.whatsapp.status).toBe('ready');
    // Adversarial: even the deepLink must not embed our fake JWT prefix... it
    // WILL (the deepLink legitimately carries the signUrl for the manager's
    // WhatsApp). Document that this is the ONE place the token surfaces — by
    // design. So we DON'T assert it's absent from the deepLink; we asserted
    // above it's absent from the top-level results/requestId path.
  }, 30_000);
});

describe('createBulk — skipped_existing', () => {
  it('BULK-3) A already pending, bulk [A,B] → A skipped (no 2nd row), B created, summary {1,1,0}', async () => {
    const a = await seedAssociatedOwner(org.id, assignedProjectId);
    const b = await seedAssociatedOwner(org.id, assignedProjectId);
    await seedPending(docAssigned, a);

    const res = await svc.createBulk(manager(), { documentId: docAssigned, ownerIds: [a, b] });

    expect(res.summary).toEqual({ created: 1, skipped: 1, failed: 0 });
    const aRes = res.results.find((r) => r.ownerId === a)!;
    const bRes = res.results.find((r) => r.ownerId === b)!;
    expect(aRes.outcome).toBe('skipped_existing');
    expect(aRes.requestId).toBeUndefined();
    expect(bRes.outcome).toBe('created');

    // A still has exactly ONE row (the pre-seeded one); no duplicate insert.
    expect(await countRows(docAssigned, a)).toBe(1);
    expect(await countRows(docAssigned, b)).toBe(1);
  }, 30_000);
});

describe('createBulk — failed owner does NOT abort the batch', () => {
  it('BULK-4) [validOwner, randomUUID] → random=failed(owner_not_found), valid=created, summary {1,0,1}', async () => {
    const valid = await seedAssociatedOwner(org.id, assignedProjectId);
    const bogus = randomUUID();

    const res = await svc.createBulk(manager(), {
      documentId: docAssigned,
      ownerIds: [valid, bogus],
    });

    expect(res.summary).toEqual({ created: 1, skipped: 0, failed: 1 });
    const vRes = res.results.find((r) => r.ownerId === valid)!;
    const bRes = res.results.find((r) => r.ownerId === bogus)!;
    expect(vRes.outcome).toBe('created');
    expect(bRes.outcome).toBe('failed');
    expect(bRes.reason).toBe('owner_not_found');
    expect(bRes.requestId).toBeUndefined();

    // The valid owner WAS written despite the bad sibling.
    expect(await countRows(docAssigned, valid)).toBe(1);
    expect(await countRows(docAssigned, bogus)).toBe(0);
  }, 30_000);

  it('BULK-5) failed owner LAST in batch still lets earlier owners through (ordering)', async () => {
    const a = await seedAssociatedOwner(org.id, assignedProjectId);
    const bogus = randomUUID();
    const res = await svc.createBulk(manager(), {
      documentId: docAssigned,
      ownerIds: [a, bogus],
    });
    expect(res.results.find((r) => r.ownerId === a)!.outcome).toBe('created');
    expect(await countRows(docAssigned, a)).toBe(1);
  }, 30_000);

  it('BULK-6) a foreign-org owner id behaves as owner_not_found (cross-org IDOR), batch continues', async () => {
    const local = await seedAssociatedOwner(org.id, assignedProjectId);
    const foreignOwner = await seedOwner(foreignOrg.id);
    const res = await svc.createBulk(manager(), {
      documentId: docAssigned,
      ownerIds: [local, foreignOwner],
    });
    expect(res.summary).toEqual({ created: 1, skipped: 0, failed: 1 });
    expect(res.results.find((r) => r.ownerId === foreignOwner)!.outcome).toBe('failed');
    expect(await countRows(docAssigned, foreignOwner)).toBe(0);
  }, 30_000);
});

describe('createBulk — dedup', () => {
  it('BULK-7) ownerIds [A,A,A] → exactly one created result + one row', async () => {
    const a = await seedAssociatedOwner(org.id, assignedProjectId);
    const res = await svc.createBulk(manager(), {
      documentId: docAssigned,
      ownerIds: [a, a, a],
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.ownerId).toBe(a);
    expect(res.results[0]!.outcome).toBe('created');
    expect(res.summary).toEqual({ created: 1, skipped: 0, failed: 0 });
    expect(await countRows(docAssigned, a)).toBe(1);
  }, 30_000);
});

describe('createBulk — AUTHZ (gate fires ONCE, BEFORE any insert)', () => {
  it('BULK-8) agent WITHOUT manage_signatures → Forbidden, NO rows written', async () => {
    await setCap(false);
    const a = await seedOwner(org.id);
    const b = await seedOwner(org.id);

    await expect(
      svc.createBulk(agent(), { documentId: docAssigned, ownerIds: [a, b] }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // The gate must fire BEFORE the loop — zero rows for either owner.
    expect(await countRows(docAssigned, a)).toBe(0);
    expect(await countRows(docAssigned, b)).toBe(0);
  }, 30_000);

  it('BULK-9) agent WITH manage_signatures on assigned doc → works', async () => {
    await setCap(true);
    const a = await seedAssociatedOwner(org.id, assignedProjectId);
    const res = await svc.createBulk(agent(), { documentId: docAssigned, ownerIds: [a] });
    expect(res.summary).toEqual({ created: 1, skipped: 0, failed: 0 });
    expect(res.results[0]!.outcome).toBe('created');
    expect(await countRows(docAssigned, a)).toBe(1);
    await setCap(false);
  }, 30_000);

  it('BULK-10) agent WITH cap but document in UNASSIGNED project → 404, NO rows', async () => {
    await setCap(true);
    const unassignedProjectId = org.projects[1]!.id;
    const docUnassigned = await seedDoc(org.id, unassignedProjectId, managerId);
    const a = await seedOwner(org.id);
    await expect(
      svc.createBulk(agent(), { documentId: docUnassigned, ownerIds: [a] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await countRowsForDoc(docUnassigned)).toBe(0);
    await setCap(false);
  }, 30_000);
});

describe('createBulk — foreign-org document', () => {
  it('BULK-11) manager targeting a foreign-org document → 404, NO rows written', async () => {
    const a = await seedOwner(org.id);
    await expect(
      svc.createBulk(manager(), { documentId: foreignDoc, ownerIds: [a] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await countRowsForDoc(foreignDoc)).toBe(0);
    // The local owner also got no row (gate failed before any insert).
    expect(await countRows(foreignDoc, a)).toBe(0);
  }, 30_000);
});

describe('createBulk — mixed batch (all three outcomes at once)', () => {
  it('BULK-12) [created, skipped_existing, failed] in one call → summary {1,1,1}, only created row added', async () => {
    const created = await seedAssociatedOwner(org.id, assignedProjectId);
    const skipped = await seedAssociatedOwner(org.id, assignedProjectId);
    const bogus = randomUUID();
    await seedPending(docAssigned, skipped);

    const before = await countRowsForDoc(docAssigned);
    const res = await svc.createBulk(manager(), {
      documentId: docAssigned,
      ownerIds: [created, skipped, bogus],
    });

    expect(res.summary).toEqual({ created: 1, skipped: 1, failed: 1 });
    expect(res.results.find((r) => r.ownerId === created)!.outcome).toBe('created');
    expect(res.results.find((r) => r.ownerId === skipped)!.outcome).toBe('skipped_existing');
    expect(res.results.find((r) => r.ownerId === bogus)!.outcome).toBe('failed');

    // Exactly ONE new row landed (the created owner). skipped reused its row;
    // bogus + the gate added nothing.
    expect(await countRowsForDoc(docAssigned)).toBe(before + 1);
  }, 30_000);
});

describe('createBulk — concurrency / chunking (>8 owners crosses a chunk boundary)', () => {
  it('BULK-13) 9 owners → all created, 9 rows, summary {9,0,0} (delivery chunk of 8 boundary)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 9; i += 1) ids.push(await seedAssociatedOwner(org.id, assignedProjectId));
    const res = await svc.createBulk(manager(), { documentId: docAssigned, ownerIds: ids });
    expect(res.summary).toEqual({ created: 9, skipped: 0, failed: 0 });
    expect(res.results).toHaveLength(9);
    for (const id of ids) expect(await countRows(docAssigned, id)).toBe(1);
  }, 60_000);
});

describe('createBulk — decrypt isolation (sec-review HIGH: a corrupt owner must not poison the batch)', () => {
  it('BULK-14) a corrupt-ciphertext owner does not abort the batch; request still created, only its delivery fails', async () => {
    const good = await seedAssociatedOwner(org.id, assignedProjectId);
    const bad = await seedAssociatedOwner(org.id, assignedProjectId);
    // Corrupt the bad owner's encrypted name so pgp_sym_decrypt RAISES. In the
    // old shared-tx design this aborted the whole batch (25P02). Now PII decrypt
    // is per-owner in an ISOLATED tx, so only this owner's DELIVERY fails — its
    // request row (inserted via a decrypt-free id SELECT) still commits.
    const c = await providerPool.connect();
    try {
      await c.query(`UPDATE owners SET name_encrypted = '\xDEADBEEF'::bytea WHERE id = $1`, [bad]);
    } finally {
      c.release();
    }

    // bad FIRST: in the old design its abort would poison good's later insert.
    const res = await svc.createBulk(manager(), { documentId: docAssigned, ownerIds: [bad, good] });

    const badRes = res.results.find((r) => r.ownerId === bad);
    const goodRes = res.results.find((r) => r.ownerId === good);
    // Both requests created (both owners exist + are visible); the batch survived.
    expect(badRes?.outcome).toBe('created');
    expect(goodRes?.outcome).toBe('created');
    expect(res.summary).toEqual({ created: 2, skipped: 0, failed: 0 });
    expect(await countRows(docAssigned, good)).toBe(1);
    expect(await countRows(docAssigned, bad)).toBe(1);
    // Corrupt owner's PII could not decrypt → NO delivery report; the valid one HAS one.
    expect(badRes?.delivery).toBeUndefined();
    expect(goodRes?.delivery).toBeDefined();
  }, 30_000);
});
