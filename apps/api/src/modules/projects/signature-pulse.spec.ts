/**
 * E2 Wave-2 B1 — `GET /api/v1/org/signature-pulse` real-DB spec.
 *
 * Proves, against a real Postgres with RLS on:
 *  - AGENT-SCOPE: an agent sees ONLY assigned projects; a manager the whole org;
 *    an unassigned project NEVER leaks into the agent's feed; a cross-tenant
 *    org sees an empty feed.
 *  - PULSE FIELDS: stalledDays, lastSignatureAt, signedThisWeek, nextExpiryAt,
 *    expiringSoon compute correctly from signature_requests + project docs.
 *  - CONSENT IS SINGLE-SOURCE: the row's consentedPct/metThreshold MATCH the
 *    per-project board's signatureProgress() to the percentage point.
 *  - rankAttention ORDERING: the most-urgent project is first.
 *  - needsHuman + buckets derive from the same rows.
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  buildings,
  documents,
  encryptOwnerPii,
  owners,
  ownerships,
  projectAssignments,
  projects,
  signatureRequests,
  withTenant,
} from '@emapp/db';
import { SignaturePulseSchema } from '@emapp/shared-types';
import { sql } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { db } from '../../../../../packages/db/src/client';
import { memberships, users } from '../../../../../packages/db/src/schema/tenancy';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsService } from './projects.service';

let svc: ProjectsService;
let org: TestOrg;
let otherOrg: TestOrg;
let managerId: string;
let agentId: string;

// P1, P2 assigned to the agent; P3 NOT assigned.
const P: { p1: string; p2: string; p3: string } = { p1: '', p2: '', p3: '' };

const MGR_SID = '00000000-0000-4000-8000-0000000000b1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000b2';

function manager(o: TestOrg = org): AccessTokenPayload {
  return {
    sub: o === org ? managerId : o.users[0]!.id,
    orgId: o.id,
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

async function seedAgentUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `pulse-agent-${randomUUID()}@test.local`,
      name: 'Agent',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId: org.id, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

let nidCounter = 200000007;
/** Owner with a UNIQUE national_id + an ACTIVE 100% ownership on `aptId`. */
async function seedOwner(aptId: string): Promise<string> {
  const nid = String(nidCounter++);
  return withTenant(org.id, async (tx) => {
    const enc = await encryptOwnerPii(tx as never, {
      name: `בעלים ${nid}`,
      nationalId: nid,
      phone: '050' + nid.slice(2),
    });
    const [own] = await tx
      .insert(owners)
      .values({
        orgId: org.id,
        nameEncrypted: enc.nameEncrypted,
        nameHash: enc.nameHash,
        nationalIdEncrypted: enc.nationalIdEncrypted,
        nationalIdHash: enc.nationalIdHash,
        phoneEncrypted: enc.phoneEncrypted,
        phoneHash: enc.phoneHash,
      })
      .returning({ id: owners.id });
    await tx
      .insert(ownerships)
      .values({ apartmentId: aptId, ownerId: own!.id, ownershipPct: '100', role: 'owner' });
    return own!.id;
  });
}

async function seedApartment(projectId: string): Promise<string> {
  return withTenant(org.id, async (tx) => {
    const [b] = await tx
      .insert(buildings)
      .values({ projectId, address: `Herzl ${randomUUID().slice(0, 4)}`, city: 'Tel Aviv' })
      .returning({ id: buildings.id });
    const [a] = await tx
      .insert(apartments)
      .values({
        buildingId: b!.id,
        number: String(Math.floor(Math.random() * 9000) + 1000),
        floor: 1,
      })
      .returning({ id: apartments.id });
    return a!.id;
  });
}

async function seedProjectDoc(projectId: string): Promise<string> {
  return withTenant(org.id, async (tx) => {
    const [d] = await tx
      .insert(documents)
      .values({
        orgId: org.id,
        projectId,
        name: 'Project Plan',
        type: 'contract',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        r2Key: `org/${org.id}/doc/${randomUUID()}.pdf`,
        contentHash: 'sha256:' + 'd'.repeat(64),
        uploadedBy: managerId,
        uploadedAt: new Date(),
      })
      .returning({ id: documents.id });
    return d!.id;
  });
}

/** Seed a signature_request; lets the spec control signed_at + expires_at so the
 *  staleness/expiry/week math is deterministic. */
async function seedSig(
  documentId: string,
  ownerId: string,
  status: 'signed' | 'pending' | 'cancelled',
  opts: { signedAt?: Date; expiresAt?: Date } = {},
): Promise<void> {
  await withTenant(org.id, async (tx) => {
    await tx.insert(signatureRequests).values({
      orgId: org.id,
      documentId,
      ownerId,
      jti: `jti-${randomUUID()}`,
      status,
      signedAt: status === 'signed' ? (opts.signedAt ?? new Date()) : null,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: managerId,
    });
  });
}

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ProjectsService(); // no cache wired → fresh-compute path (cache path
  // is the same value; the no-cache path keeps the spec hermetic).
  const tag = `pulse-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  otherOrg = await createTestOrg(`${tag}-other`, `${tag}-other`);
  managerId = org.users[0]!.id;

  P.p1 = org.projects[0]!.id;
  P.p2 = org.projects[1]!.id;
  P.p3 = await withTenant(org.id, async (tx) => {
    const [p] = await tx
      .insert(projects)
      .values({ orgId: org.id, name: `${tag} Project 3`, type: 'tama38_1', createdBy: managerId })
      .returning({ id: projects.id });
    return p!.id;
  });

  agentId = await seedAgentUser();
  await db.insert(projectAssignments).values([
    { projectId: P.p1, userId: agentId, assignedBy: managerId },
    { projectId: P.p2, userId: agentId, assignedBy: managerId },
  ]);

  // Set explicit targets so metThreshold is assertable.
  await withTenant(org.id, async (tx) => {
    await tx.execute(sql`UPDATE projects SET target_signature_pct = 50 WHERE id = ${P.p1}`);
    await tx.execute(sql`UPDATE projects SET target_signature_pct = 80 WHERE id = ${P.p2}`);
    await tx.execute(sql`UPDATE projects SET target_signature_pct = 60 WHERE id = ${P.p3}`);
  });

  // ── P1 — STALLED + far below target. 2 apartments, 1 owner each. One signed
  //    LONG ago (stalled), the other unsigned. Last signature 40 days ago →
  //    stalledDays ≈ 40 (>= floor). consentedPct = 50 (1 of 2 apts fully signed)
  //    → meets the 50 target.
  const p1a1 = await seedApartment(P.p1);
  const p1o1 = await seedOwner(p1a1);
  const p1a2 = await seedApartment(P.p1);
  await seedOwner(p1a2); // unsigned owner
  const p1doc = await seedProjectDoc(P.p1);
  await seedSig(p1doc, p1o1, 'signed', { signedAt: new Date(Date.now() - 40 * DAY) });

  // ── P2 — EXPIRING SOON. 1 apt/owner signed RECENTLY (this week) + a PENDING
  //    request that expires in 3 days (< 7 → expiringSoon). consentedPct = 100
  //    → meets the 80 target.
  const p2a1 = await seedApartment(P.p2);
  const p2o1 = await seedOwner(p2a1);
  const p2doc = await seedProjectDoc(P.p2);
  await seedSig(p2doc, p2o1, 'signed', { signedAt: new Date(Date.now() - 2 * DAY) });
  // a second apartment with a PENDING request expiring soon (drives nextExpiryAt)
  const p2a2 = await seedApartment(P.p2);
  const p2o2 = await seedOwner(p2a2);
  await seedSig(p2doc, p2o2, 'pending', { expiresAt: new Date(Date.now() + 3 * DAY) });

  // ── P3 (UNASSIGNED) — must NEVER appear for the agent. Far below target,
  //    stalled, so if it leaked it would rank FIRST and be obvious.
  const p3a1 = await seedApartment(P.p3);
  const p3o1 = await seedOwner(p3a1);
  await seedApartment(P.p3); // unsigned apt → low consent
  const p3doc = await seedProjectDoc(P.p3);
  await seedSig(p3doc, p3o1, 'signed', { signedAt: new Date(Date.now() - 90 * DAY) });
}, 180_000);

afterAll(() => {
  /* shared pools closed by global teardown */
});

describe('signaturePulse — agent-scope', () => {
  it('SP-1) agent sees ONLY assigned projects (P1+P2), NOT P3', async () => {
    const pulse = await svc.signaturePulse(agent());
    const ids = pulse.attention.map((r) => r.projectId).sort();
    expect(ids).toEqual([P.p1, P.p2].sort());
    expect(ids).not.toContain(P.p3);
  });

  it('SP-2) manager sees the whole org (P1+P2+P3)', async () => {
    const pulse = await svc.signaturePulse(manager());
    const ids = pulse.attention.map((r) => r.projectId).sort();
    expect(ids).toEqual([P.p1, P.p2, P.p3].sort());
  });

  it('SP-3) a cross-tenant org sees an EMPTY feed for our projects (no leak)', async () => {
    const pulse = await svc.signaturePulse(manager(otherOrg));
    const ids = pulse.attention.map((r) => r.projectId);
    expect(ids).not.toContain(P.p1);
    expect(ids).not.toContain(P.p2);
    expect(ids).not.toContain(P.p3);
  });

  it('SP-4) the payload conforms to SignaturePulseSchema (envelope-ready)', async () => {
    const pulse = await svc.signaturePulse(manager());
    expect(() => SignaturePulseSchema.parse(pulse)).not.toThrow();
  });
});

describe('signaturePulse — pulse fields', () => {
  it('SP-5) P1 stalledDays reflects the 40-day-old last signature (>= floor)', async () => {
    const pulse = await svc.signaturePulse(manager());
    const p1 = pulse.attention.find((r) => r.projectId === P.p1)!;
    expect(p1.lastSignatureAt).not.toBeNull();
    expect(p1.stalledDays).toBeGreaterThanOrEqual(39);
    expect(p1.stalledDays).toBeLessThanOrEqual(41);
  });

  it('SP-6) P2 has a recent signature this week + expiringSoon pending', async () => {
    const pulse = await svc.signaturePulse(manager());
    const p2 = pulse.attention.find((r) => r.projectId === P.p2)!;
    expect(p2.signedThisWeek).toBeGreaterThanOrEqual(1);
    expect(p2.expiringSoon).toBe(true);
    expect(p2.nextExpiryAt).not.toBeNull();
    // not stalled — signed 2 days ago.
    expect(p2.stalledDays).toBeLessThan(14);
  });

  it('SP-7) P1 has NO pending request → nextExpiryAt null, not expiring', async () => {
    const pulse = await svc.signaturePulse(manager());
    const p1 = pulse.attention.find((r) => r.projectId === P.p1)!;
    expect(p1.nextExpiryAt).toBeNull();
    expect(p1.expiringSoon).toBe(false);
  });
});

describe('signaturePulse — consent is single-source with the board', () => {
  it('SP-8) row consentedPct/metThreshold EQUAL the per-project board values', async () => {
    const pulse = await svc.signaturePulse(manager());
    for (const projectId of [P.p1, P.p2, P.p3]) {
      const row = pulse.attention.find((r) => r.projectId === projectId)!;
      const board = await svc.signatureProgress(manager(), projectId);
      expect(row.consentedPct).toBe(board.consentedPct);
      expect(row.metThreshold).toBe(board.metThreshold);
      expect(row.basis).toBe('share');
    }
  });
});

describe('signaturePulse — rankAttention + buckets', () => {
  it('SP-9) the most-urgent project floats to the top (manager view)', async () => {
    const pulse = await svc.signaturePulse(manager());
    // P3 is stalled 90d + far below its 60 target + no expiry; P1 stalled 40d but
    // MEETS its target; P2 met + only expiring. P3 should outrank P1 which
    // outranks P2 on stall pressure. Assert P3 first among manager's set.
    expect(pulse.attention[0]!.projectId).toBe(P.p3);
  });

  it('SP-10) buckets + needsHuman derive from the rows (counts only, no PII)', async () => {
    const pulse = await svc.signaturePulse(manager());
    const total = pulse.buckets.stalled + pulse.buckets.expiringSoon + pulse.buckets.onTrack;
    expect(total).toBe(pulse.attention.length);
    // stalled bucket: P1 (40d) + P3 (90d) = 2.
    expect(pulse.buckets.stalled).toBeGreaterThanOrEqual(2);
    // needsHuman entries carry ONLY projectId/name/reasons/count — no PII keys.
    for (const nh of pulse.needsHuman) {
      expect(Object.keys(nh).sort()).toEqual(['count', 'projectId', 'projectName', 'reasons']);
    }
  });
});
