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
  PostgresCacheProvider,
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
import { StatsCacheService } from './stats-cache.service';

let svc: ProjectsService;
let org: TestOrg;
let otherOrg: TestOrg;
let managerId: string;
let agentId: string;

// P1, P2 assigned to the agent; P3 NOT assigned. P4/P5 added for HB-5
// campaign-document derivation (P4: no campaign at all; P5: a finalized
// 'agreement' doc but no signature_request yet).
const P: {
  p1: string;
  p2: string;
  p3: string;
  p4: string;
  p5: string;
  p5agreement: string;
} = {
  p1: '',
  p2: '',
  p3: '',
  p4: '',
  p5: '',
  p5agreement: '',
};

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

async function seedProjectDoc(
  projectId: string,
  opts: { type?: string; uploadedAt?: Date | null; archivedAt?: Date | null } = {},
): Promise<string> {
  return withTenant(org.id, async (tx) => {
    const [d] = await tx
      .insert(documents)
      .values({
        orgId: org.id,
        projectId,
        name: 'Project Plan',
        type: opts.type ?? 'contract',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        r2Key: `org/${org.id}/doc/${randomUUID()}.pdf`,
        contentHash: 'sha256:' + 'd'.repeat(64),
        uploadedBy: managerId,
        // 0049 — finalized iff uploadedAt NOT NULL. Default finalized; callers
        // may pass null to seed a never-finalized "ghost" doc.
        uploadedAt: opts.uploadedAt === undefined ? new Date() : opts.uploadedAt,
        archivedAt: opts.archivedAt ?? null,
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
  const seedProject = async (suffix: string): Promise<string> =>
    withTenant(org.id, async (tx) => {
      const [p] = await tx
        .insert(projects)
        .values({
          orgId: org.id,
          name: `${tag} Project ${suffix}`,
          type: 'tama38_1',
          createdBy: managerId,
        })
        .returning({ id: projects.id });
      return p!.id;
    });
  P.p3 = await seedProject('3');
  P.p4 = await seedProject('4');
  P.p5 = await seedProject('5');

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

  // ── P4 (HB-5) — NO CAMPAIGN at all: an apartment + owner but NO
  //    signature_request ever AND no finalized 'agreement' doc. (It has a
  //    finalized 'contract' doc to prove the type filter excludes non-agreement
  //    docs.) → campaignDocumentId null, hasCampaign false.
  const p4a1 = await seedApartment(P.p4);
  await seedOwner(p4a1);
  await seedProjectDoc(P.p4, { type: 'contract' }); // non-agreement → ignored
  // an ARCHIVED agreement + a NEVER-FINALIZED agreement → both ignored.
  await seedProjectDoc(P.p4, { type: 'agreement', archivedAt: new Date() });
  await seedProjectDoc(P.p4, { type: 'agreement', uploadedAt: null });

  // ── P5 (HB-5) — campaign DOC, no requests yet: a FINALIZED, non-archived,
  //    project-scoped 'agreement' doc but NO signature_request. The fallback
  //    (precedence rule 2) must resolve campaignDocumentId to THIS doc.
  const p5a1 = await seedApartment(P.p5);
  await seedOwner(p5a1);
  // an older finalized agreement + the newest one → expect the NEWEST by uploaded_at.
  await seedProjectDoc(P.p5, { type: 'agreement', uploadedAt: new Date(Date.now() - 5 * DAY) });
  P.p5agreement = await seedProjectDoc(P.p5, {
    type: 'agreement',
    uploadedAt: new Date(Date.now() - 1 * DAY),
  });
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

  it('SP-2) manager sees the whole org (P1..P5)', async () => {
    const pulse = await svc.signaturePulse(manager());
    const ids = pulse.attention.map((r) => r.projectId).sort();
    expect(ids).toEqual([P.p1, P.p2, P.p3, P.p4, P.p5].sort());
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
  // Real-DB: one pulse call (now over 5 seeded projects) + 3 per-project board
  // calls in a loop against the remote (Neon) dev DB. The default 5s `it`
  // timeout is too tight for that many sequential round-trips over the network;
  // give it the suite's heavier budget (the assertion, not latency, is the gate).
  it('SP-8) row consentedPct/metThreshold EQUAL the per-project board values', async () => {
    const pulse = await svc.signaturePulse(manager());
    for (const projectId of [P.p1, P.p2, P.p3]) {
      const row = pulse.attention.find((r) => r.projectId === projectId)!;
      const board = await svc.signatureProgress(manager(), projectId);
      expect(row.consentedPct).toBe(board.consentedPct);
      expect(row.metThreshold).toBe(board.metThreshold);
      expect(row.basis).toBe('share');
    }
  }, 30_000);
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

describe('signaturePulse — HB-5 campaign document (one-click holdout chase)', () => {
  it('SP-11) a project with signature_requests → campaignDocumentId = its most-recent request doc; hasCampaign true', async () => {
    const pulse = await svc.signaturePulse(manager());
    for (const projectId of [P.p1, P.p2, P.p3]) {
      const row = pulse.attention.find((r) => r.projectId === projectId)!;
      // P1/P2/P3 each have ≥1 signature_request → precedence rule 1 fires.
      expect(row.campaignDocumentId).not.toBeNull();
      expect(row.hasCampaign).toBe(true);
    }
  });

  it('SP-12) a project with NO campaign (no request, no finalized agreement) → null / false', async () => {
    const pulse = await svc.signaturePulse(manager());
    const p4 = pulse.attention.find((r) => r.projectId === P.p4)!;
    // Non-agreement / archived-agreement / never-finalized-agreement are all
    // excluded, and there is no signature_request → no campaign.
    expect(p4.campaignDocumentId).toBeNull();
    expect(p4.hasCampaign).toBe(false);
  });

  it('SP-13) a project with a finalized agreement but no request → falls back to that agreement doc', async () => {
    const pulse = await svc.signaturePulse(manager());
    const p5 = pulse.attention.find((r) => r.projectId === P.p5)!;
    // Precedence rule 2: the NEWEST finalized, non-archived, project-scoped
    // 'agreement' doc (uploaded 1 day ago, not the 5-day-old one).
    expect(p5.campaignDocumentId).toBe(P.p5agreement);
    expect(p5.hasCampaign).toBe(true);
  });
});

/**
 * G4 — BOUNDED-CONCURRENCY per-project consent.
 *
 * The pulse's per-project consent aggregates were SEQUENTIAL (`await` inside a
 * `for`); at 100+ projects the COLD path (after a consent write bumps the org
 * epoch, invalidating every cached aggregate) did N sequential aggregate
 * queries → a latency wall. They are now resolved with BOUNDED concurrency
 * (chunks of PULSE_CONSENT_CONCURRENCY). These tests prove, against the REAL DB
 * + REAL cache, at SCALE (SCALE_N projects in a dedicated org):
 *
 *   SP-14 — CORRECTNESS: the parallel cached pulse is BYTE-IDENTICAL (rows in
 *           the same order, same consentedPct/metThreshold) to the sequential
 *           fresh-compute ground truth. This is the share-weighted consent law;
 *           a drift here would be a correctness bug, not just perf.
 *   SP-15 — POOL SAFETY + PERF: a COLD pulse over SCALE_N projects (every
 *           aggregate a cache MISS after invalidateOrg) completes WITHOUT a
 *           pool-exhaustion / connection-timeout error, and we record the
 *           cold-vs-warm latency so the parallelisation is measured, not felt.
 */
describe('signaturePulse — G4 bounded-concurrency consent (scale + correctness)', () => {
  const SCALE_N = 40;
  let scaleOrg: TestOrg;
  let scaleMgrId: string;
  let cache: StatsCacheService;
  let cachedSvc: ProjectsService; // parallel path, real cache
  let freshSvc: ProjectsService; // ground truth, no cache (still sequential-equivalent output)

  function scaleManager(): AccessTokenPayload {
    return {
      sub: scaleMgrId,
      orgId: scaleOrg.id,
      role: 'manager',
      sid: '00000000-0000-4000-8000-0000000000c9',
      type: 'access',
    } as unknown as AccessTokenPayload;
  }

  // Seed one self-contained project: 2 apartments (1 owner each), a project
  // doc, and a signed request on the FIRST apartment's owner → a KNOWN, varied
  // consent (≈50% share on a 2-apt project) so the assertion is meaningful, not
  // all-zero. A per-project target makes metThreshold assertable + varied.
  async function seedScaleProject(idx: number): Promise<string> {
    const projectId = await withTenant(scaleOrg.id, async (tx) => {
      const [p] = await tx
        .insert(projects)
        .values({
          orgId: scaleOrg.id,
          name: `scale-${idx}-${randomUUID().slice(0, 4)}`,
          type: 'tama38_1',
          createdBy: scaleMgrId,
          // Alternate the target so metThreshold flips across the set: even idx
          // targets 40 (≈50% consent MEETS), odd targets 60 (does NOT meet).
          targetSignaturePct: idx % 2 === 0 ? '40.00' : '60.00',
        })
        .returning({ id: projects.id });
      return p!.id;
    });
    const a1 = await seedApartmentScale(projectId);
    const o1 = await seedOwnerScale(a1);
    const a2 = await seedApartmentScale(projectId);
    await seedOwnerScale(a2); // unsigned → drives consent below 100%
    const doc = await seedProjectDocScale(projectId);
    await seedSigScale(doc, o1);
    return projectId;
  }

  async function seedApartmentScale(projectId: string): Promise<string> {
    return withTenant(scaleOrg.id, async (tx) => {
      const [b] = await tx
        .insert(buildings)
        .values({ projectId, address: `Sokolov ${randomUUID().slice(0, 4)}`, city: 'Tel Aviv' })
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

  async function seedOwnerScale(aptId: string): Promise<string> {
    const nid = String(nidCounter++);
    return withTenant(scaleOrg.id, async (tx) => {
      const enc = await encryptOwnerPii(tx as never, {
        name: `בעלים ${nid}`,
        nationalId: nid,
        phone: '050' + nid.slice(2),
      });
      const [own] = await tx
        .insert(owners)
        .values({
          orgId: scaleOrg.id,
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

  async function seedProjectDocScale(projectId: string): Promise<string> {
    return withTenant(scaleOrg.id, async (tx) => {
      const [d] = await tx
        .insert(documents)
        .values({
          orgId: scaleOrg.id,
          projectId,
          name: 'Scale Plan',
          type: 'agreement',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          r2Key: `org/${scaleOrg.id}/doc/${randomUUID()}.pdf`,
          contentHash: 'sha256:' + 'e'.repeat(64),
          uploadedBy: scaleMgrId,
          uploadedAt: new Date(),
        })
        .returning({ id: documents.id });
      return d!.id;
    });
  }

  async function seedSigScale(documentId: string, ownerId: string): Promise<void> {
    await withTenant(scaleOrg.id, async (tx) => {
      await tx.insert(signatureRequests).values({
        orgId: scaleOrg.id,
        documentId,
        ownerId,
        jti: `jti-${randomUUID()}`,
        status: 'signed',
        signedAt: new Date(Date.now() - 3 * DAY),
        expiresAt: new Date(Date.now() + 30 * DAY),
        createdBy: scaleMgrId,
      });
    });
  }

  beforeAll(async () => {
    const tag = `pulse-scale-${Date.now()}`;
    scaleOrg = await createTestOrg(tag, tag);
    scaleMgrId = scaleOrg.users[0]!.id;
    cache = new StatsCacheService(new PostgresCacheProvider());
    cachedSvc = new ProjectsService(cache);
    freshSvc = new ProjectsService();
    // createTestOrg seeds 2 projects already; top up to SCALE_N total.
    const existing = scaleOrg.projects.length;
    for (let i = existing; i < SCALE_N; i += 1) {
      await seedScaleProject(i);
    }
  }, 300_000);

  it('SP-14) the bounded-parallel cached pulse is byte-identical to the sequential fresh compute', async () => {
    const u = scaleManager();
    // Ground truth: the no-cache service computes every aggregate fresh. The
    // output shape (rows, order, consent) is what the SEQUENTIAL loop produced.
    const fresh = await freshSvc.signaturePulse(u);
    // Parallel path: cold then warm — both must equal the ground truth.
    await cache.invalidateOrg(scaleOrg.id); // force every aggregate to MISS
    const coldParallel = await cachedSvc.signaturePulse(u);
    const warmParallel = await cachedSvc.signaturePulse(u);

    // EVERY project the manager seeded is present (SCALE_N rows, no drops).
    expect(coldParallel.attention.length).toBe(fresh.attention.length);
    expect(coldParallel.attention.length).toBeGreaterThanOrEqual(SCALE_N);

    // Order + per-project consent are IDENTICAL across all three. rankAttention
    // is a pure function of the rows, so identical rows ⇒ identical order ⇒ a
    // byte-identical `attention` array.
    expect(coldParallel.attention).toStrictEqual(fresh.attention);
    expect(warmParallel.attention).toStrictEqual(fresh.attention);
    expect(coldParallel.buckets).toStrictEqual(fresh.buckets);
    expect(coldParallel.needsHuman).toStrictEqual(fresh.needsHuman);

    // The seeded consent really IS varied (not a degenerate all-equal set that
    // would make the deep-equal trivially pass): both met + unmet thresholds.
    const metFlags = new Set(coldParallel.attention.map((r) => r.metThreshold));
    expect(metFlags.has(true)).toBe(true);
    expect(metFlags.has(false)).toBe(true);

    // INDEPENDENT slot↔projectId guard at SCALE (closes the bounded-parallel
    // chunk-offset risk): the deep-equal above compares the parallel path to
    // freshSvc, which runs the SAME bounded-parallel code — so a CONSISTENT
    // mis-slot in the `aggs[i+j]` chunk arithmetic would corrupt both and still
    // pass. Cross-check a few rows spanning chunk boundaries (first / middle /
    // last) against the per-project board computed by id via `signatureProgress`
    // (NOT the fan-out loop) — the row's consent MUST belong to ITS projectId.
    const probeRows = [
      coldParallel.attention[0]!,
      coldParallel.attention[Math.floor(coldParallel.attention.length / 2)]!,
      coldParallel.attention.at(-1)!,
    ];
    for (const row of probeRows) {
      const board = await freshSvc.signatureProgress(u, row.projectId);
      expect(row.consentedPct).toBe(board.consentedPct);
      expect(row.metThreshold).toBe(board.metThreshold);
    }
  }, 120_000);

  it('SP-15) a COLD pulse over the scaled org does not exhaust the pool + cold/warm is measured', async () => {
    const u = scaleManager();
    // COLD: every per-project aggregate is a cache MISS → the bounded-parallel
    // fan-out runs against the DB. If the fan-out were unbounded this is where
    // the pool would starve (connection-timeout); bounded, it must complete.
    await cache.invalidateOrg(scaleOrg.id);
    const t0 = Date.now();
    const cold = await cachedSvc.signaturePulse(u);
    const coldMs = Date.now() - t0;

    // WARM: every aggregate is a HIT.
    const t1 = Date.now();
    const warm = await cachedSvc.signaturePulse(u);
    const warmMs = Date.now() - t1;

    // Surface the measurement in the test log (perf is a first-class axis).
    // eslint-disable-next-line no-console
    console.info(
      `[SP-15] signaturePulse over ${cold.attention.length} projects — cold(parallel,MISS)=${coldMs}ms warm(HIT)=${warmMs}ms`,
    );

    // The run COMPLETED (no pool-exhaustion throw) and returned the full set.
    expect(cold.attention.length).toBeGreaterThanOrEqual(SCALE_N);
    expect(warm.attention).toStrictEqual(cold.attention);
  }, 120_000);
});
