/**
 * Rich DEMO seed — makes the existing Alpha dev org look like ONE
 * organization in active mid-workflow, populated across EVERY entity.
 *
 * Run AFTER the baseline seed (`seed:dev`) which creates Alpha + the
 * manager/agent/viewer users. This script ADDS, on top of Alpha:
 *   - 6 projects covering all 6 status values (D.18) + the existing Pilot
 *   - buildings (+1 section each) and apartments with mixed outreach status
 *   - ~40 PII-encrypted owners + ownerships (sum=100 per apt, mixed splits)
 *   - documents (regulation/blueprint/agreement) — metadata only
 *   - signature requests + signatures in mixed states (realistic progress)
 *   - contractors + shares (Tier-2 external, JSONB permission matrix)
 *   - tasks + assignees (some calendar-scheduled), notifications, and
 *     project assignments (so the Agent sees "assigned projects")
 *
 * Idempotent: guarded by a sentinel project name. A re-run detects it and
 * short-circuits. Atomic: the whole demo is ONE withBootstrap transaction,
 * so the deferred ownership-sum=100 trigger validates at commit.
 *
 * NOT for production — refuses to run unless NODE_ENV=development, and
 * requires PII keys (Infisical dev).
 */
/* eslint-disable no-console -- dev fixture tool; prints fixture info to stdout. */
import { createHash, randomUUID } from 'crypto';
import { pathToFileURL } from 'url';

import { and, eq } from 'drizzle-orm';

import { closeAllPools } from '../src/client';
import { env } from '../src/env';
import { encryptOwnerPiiBatch, type PiiFields } from '../src/helpers/owners';
import type { SharePermissions } from '../src/schema/_share-permissions';
import {
  apartments,
  buildings,
  buildingSections,
  contractors,
  documents,
  notifications,
  organizations,
  owners,
  ownerships,
  projectAssignments,
  projects,
  shares,
  signatureRequests,
  signatures,
  taskAssignees,
  tasks,
  users,
} from '../src/schema/index';
import { withBootstrap } from '../src/wrappers/with-bootstrap';

import { uploadSeedDocBytes } from './seed-storage';

const ORG_SLUG = 'alpha-dev';
const NOW = Date.now();
const DAY = 86_400_000;
const d = (daysAgo: number): Date => new Date(NOW - daysAgo * DAY);
const ahead = (days: number, hour = 10): Date => {
  const dt = new Date(NOW + days * DAY);
  dt.setHours(hour, 0, 0, 0);
  return dt;
};

// === Israeli national-ID check digit (mirrors seed-dev.ts) ===
function israeliCheckDigit(first8: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    const n = Number(first8[i]);
    const w = (i % 2) + 1;
    const p = n * w;
    sum += p >= 10 ? Math.floor(p / 10) + (p % 10) : p;
  }
  return String((10 - (sum % 10)) % 10);
}
function luhnId(first8: string): string {
  return first8 + israeliCheckDigit(first8);
}

// === Hebrew name pools (deterministic combination by index) ===
const FIRST = [
  'דנה',
  'יוסי',
  'שרה',
  'משה',
  'רבקה',
  'אבי',
  'נועה',
  'יעקב',
  'מירי',
  'דוד',
  'חנה',
  'איתי',
  'טל',
  'רונית',
  'עומר',
  'ליאת',
  'גיל',
  'שירה',
  'אורן',
  'מאיה',
  'בני',
  'ענת',
  'רן',
  'סיגל',
  'אסף',
  'דפנה',
  'ניר',
  'קרן',
  'עידן',
  'הילה',
  'גלעד',
  'ורד',
  'אורי',
  'תמר',
  'יואב',
  'מיכל',
  'אלון',
  'נטע',
  'עמית',
  'שני',
];
const LAST = [
  'כהן',
  'לוי',
  'מזרחי',
  'פרץ',
  'ביטון',
  'דהן',
  'אזולאי',
  'אברהם',
  'פרידמן',
  'שפירא',
  'גולן',
  'ברק',
  'רוזן',
  'שמש',
  'חדד',
  'נחום',
  'בר',
  'גבאי',
  'מלכה',
  'עמר',
];
const MOBILE_PREFIX = ['50', '52', '53', '54', '58'];

// === Sentinel — re-run guard ===
const DEMO_MARKER = 'תמ״א 38/1 — ביאליק 8 (דמו)';

interface DemoProject {
  name: string;
  type: 'tama38_1' | 'tama38_2' | 'pinui_binui';
  status:
    | 'planning'
    | 'gathering_signatures'
    | 'approved'
    | 'in_construction'
    | 'completed'
    | 'cancelled';
  buildings: Array<{ address: string; city: string; apts: number }>;
  // apartment-status pool to draw from (cycled) — shapes the "feel" per phase
  aptStatuses: Array<'pending' | 'contacted' | 'meeting' | 'signed' | 'refused' | 'unreachable'>;
}

const DEMO_PROJECTS: DemoProject[] = [
  {
    name: DEMO_MARKER,
    type: 'tama38_1',
    status: 'planning',
    buildings: [{ address: 'ביאליק 8', city: 'רמת גן', apts: 4 }],
    aptStatuses: ['pending', 'contacted', 'pending', 'unreachable'],
  },
  {
    name: 'תמ״א 38/2 — ויצמן 20 (דמו)',
    type: 'tama38_2',
    status: 'gathering_signatures',
    buildings: [
      { address: 'ויצמן 20', city: 'גבעתיים', apts: 5 },
      { address: 'ויצמן 22', city: 'גבעתיים', apts: 5 },
    ],
    aptStatuses: [
      'signed',
      'meeting',
      'contacted',
      'signed',
      'refused',
      'meeting',
      'signed',
      'contacted',
      'unreachable',
      'signed',
    ],
  },
  {
    name: 'פינוי-בינוי — מתחם רסקו (דמו)',
    type: 'pinui_binui',
    status: 'approved',
    buildings: [{ address: 'רסקו 3', city: 'חולון', apts: 6 }],
    aptStatuses: ['signed', 'signed', 'signed', 'meeting', 'signed', 'signed'],
  },
  {
    name: 'תמ״א 38/2 — ארלוזורוב 14 (דמו)',
    type: 'tama38_2',
    status: 'in_construction',
    buildings: [
      { address: 'ארלוזורוב 14', city: 'תל אביב', apts: 5 },
      { address: 'ארלוזורוב 16', city: 'תל אביב', apts: 4 },
    ],
    aptStatuses: [
      'signed',
      'signed',
      'signed',
      'signed',
      'signed',
      'signed',
      'signed',
      'signed',
      'signed',
    ],
  },
  {
    name: 'תמ״א 38/1 — שיכון ותיקים (דמו)',
    type: 'tama38_1',
    status: 'completed',
    buildings: [{ address: 'הנרייטה סולד 5', city: 'בת ים', apts: 4 }],
    aptStatuses: ['signed', 'signed', 'signed', 'signed'],
  },
  {
    name: 'פינוי-בינוי — נווה שאנן (דמו)',
    type: 'pinui_binui',
    status: 'cancelled',
    buildings: [{ address: 'נווה שאנן 11', city: 'תל אביב', apts: 3 }],
    aptStatuses: ['refused', 'unreachable', 'refused'],
  },
];

// Ownership split patterns (each sums to exactly 100; [] = not-yet-mapped).
const SPLIT_PATTERNS: number[][] = [
  [100],
  [50, 50],
  [60, 40],
  [40, 30, 30],
  [], // not yet mapped — only applied to pending/planning apartments
];

// Contractor permission presets (must satisfy sharePermissionsSchema).
// A3 (L4): tenants/notes/team + document upload removed as DEAD keys.
const PERM_FULL: SharePermissions = {
  overview: { on: true },
  documents: { on: true, actions: { download: true } },
  signatures: { on: true },
};
const PERM_DOCS_ONLY: SharePermissions = {
  overview: { on: true },
  documents: { on: true, actions: { download: true } },
  signatures: { on: false },
};
const PERM_SIGN_VIEW: SharePermissions = {
  overview: { on: true },
  documents: { on: true, actions: { download: true } },
  signatures: { on: true },
};

const SIGNATURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60" viewBox="0 0 200 60"><path d="M10 40 Q 30 10, 50 35 T 90 30 T 130 35 T 170 32 T 190 35" stroke="#1e3a8a" stroke-width="2.2" fill="none" stroke-linecap="round"/><text x="100" y="55" font-size="9" font-family="sans-serif" text-anchor="middle" fill="#64748b">חתימה דיגיטלית — דמו</text></svg>`;

async function main(): Promise<number> {
  if (env.NODE_ENV !== 'development') {
    console.error(`[seed-demo] NODE_ENV=${env.NODE_ENV} — refusing to run outside development.`);
    return 1;
  }
  if (!env.PII_ENCRYPTION_KEY || !env.PII_HASH_KEY) {
    console.error('[seed-demo] PII keys missing — load via Infisical dev.');
    return 1;
  }

  const result = await withBootstrap(async (tx) => {
    // Resolve the existing Alpha org + manager/agent (from seed:dev).
    const org = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, ORG_SLUG))
      .limit(1);
    if (org.length === 0) {
      throw new Error(
        '[seed-demo] org alpha-dev not found — run `pnpm --filter @emapp/db seed:dev` first.',
      );
    }
    const orgId = org[0]!.id;

    const mgr = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'manager@alpha.dev'))
      .limit(1);
    const agt = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'agent@alpha.dev'))
      .limit(1);
    if (mgr.length === 0)
      throw new Error('[seed-demo] manager@alpha.dev not found — run seed:dev first.');
    const managerId = mgr[0]!.id;
    const agentId = agt[0]?.id ?? managerId;

    // Idempotency sentinel.
    const sentinel = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.name, DEMO_MARKER)))
      .limit(1);
    if (sentinel.length > 0) {
      return { skipped: true as const };
    }

    // ---- 1. Owners (bulk PII-encrypt) ----
    const OWNER_COUNT = 40;
    const ownerInputs: PiiFields[] = [];
    for (let i = 0; i < OWNER_COUNT; i += 1) {
      const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
      const nationalId = luhnId(String(20_000_000 + i)); // 8 digits → +check
      const prefix = MOBILE_PREFIX[i % MOBILE_PREFIX.length];
      const phone = `+972${prefix}${String(1_000_000 + i * 137).slice(0, 7)}`;
      ownerInputs.push({ name, nationalId, phone });
    }
    const enc = await encryptOwnerPiiBatch(tx, ownerInputs);
    const ownerIds: string[] = [];
    for (let i = 0; i < OWNER_COUNT; i += 1) {
      const id = randomUUID();
      ownerIds.push(id);
      const e = enc[i]!;
      await tx.insert(owners).values({
        id,
        orgId,
        nameEncrypted: e.nameEncrypted,
        nameHash: e.nameHash,
        email: i % 3 === 0 ? `owner${i}@example.dev` : null,
        nationalIdEncrypted: e.nationalIdEncrypted,
        nationalIdHash: e.nationalIdHash,
        phoneEncrypted: e.phoneEncrypted,
        phoneHash: e.phoneHash,
        createdAt: d(30 - (i % 30)),
        updatedAt: d(2),
      });
    }

    // ---- 2. Projects → buildings → sections → apartments → ownerships ----
    let ownerPtr = 0; // round-robin pointer into ownerIds
    let splitPtr = 0;
    const createdProjectIds: string[] = [];
    // Collect "signable" apartments: { aptId, projectId, primaryOwnerId, aptStatus }
    interface AptRef {
      aptId: string;
      projectId: string;
      number: string;
      primaryOwnerId: string | null;
      status: string;
    }
    const aptRefs: AptRef[] = [];

    let buildingsCreated = 0;
    let apartmentsCreated = 0;
    let ownershipsCreated = 0;

    for (const p of DEMO_PROJECTS) {
      const projectId = randomUUID();
      createdProjectIds.push(projectId);
      const createdDaysAgo = 45 - DEMO_PROJECTS.indexOf(p) * 5;
      await tx.insert(projects).values({
        id: projectId,
        orgId,
        name: p.name,
        type: p.type,
        status: p.status,
        description: `דמו — פרויקט ${p.type} בסטטוס ${p.status}.`,
        createdBy: managerId,
        createdAt: d(createdDaysAgo),
        updatedAt: d(3),
      });

      let aptStatusPtr = 0;
      for (const b of p.buildings) {
        const buildingId = randomUUID();
        await tx.insert(buildings).values({
          id: buildingId,
          projectId,
          address: b.address,
          city: b.city,
          aptCount: b.apts,
          createdAt: d(createdDaysAgo - 1),
          updatedAt: d(3),
        });
        buildingsCreated += 1;
        await tx.insert(buildingSections).values({
          id: randomUUID(),
          buildingId,
          entrance: 'א',
          kind: 'residential',
          floors: 4,
          unitCount: b.apts,
          gush: String(6200 + (buildingsCreated % 50)),
          helka: String(10 + (buildingsCreated % 90)),
        });

        for (let a = 0; a < b.apts; a += 1) {
          const aptId = randomUUID();
          const aptStatus = p.aptStatuses[aptStatusPtr % p.aptStatuses.length]!;
          aptStatusPtr += 1;
          const number = String(a + 1);
          await tx.insert(apartments).values({
            id: aptId,
            buildingId,
            number,
            status: aptStatus,
            statusChangedAt: d(5 + (a % 10)),
            unitType: a % 6 === 5 ? 'office' : 'apt',
            areaSqm: (60 + a * 7.5).toFixed(2),
            entrance: 'א',
            createdAt: d(createdDaysAgo - 1),
            updatedAt: d(3),
          });
          apartmentsCreated += 1;

          // Ownership: 'not-yet-mapped' ([]) only for pending/contacted.
          let pattern = SPLIT_PATTERNS[splitPtr % SPLIT_PATTERNS.length]!;
          splitPtr += 1;
          if (pattern.length === 0 && !(aptStatus === 'pending' || aptStatus === 'contacted')) {
            pattern = [100]; // signed/meeting apts must have owners
          }
          let primaryOwnerId: string | null = null;
          for (let k = 0; k < pattern.length; k += 1) {
            const ownerId = ownerIds[ownerPtr % ownerIds.length]!;
            ownerPtr += 1;
            if (k === 0) primaryOwnerId = ownerId;
            await tx.insert(ownerships).values({
              id: randomUUID(),
              apartmentId: aptId,
              ownerId,
              ownershipPct: pattern[k]!.toFixed(2),
            });
            ownershipsCreated += 1;
          }
          aptRefs.push({ aptId, projectId, number, primaryOwnerId, status: aptStatus });
        }
      }
    }

    // ---- 3. Documents (project regulation + blueprint, + per-apt agreements) ----
    let docsCreated = 0;
    // Collected for the post-commit renderable-byte upload (storage is not
    // transactional). Uploaded to real R2 after the tx so demo previews open.
    const docsForBytes: Array<{ r2Key: string; name: string }> = [];
    const projectRegulationDoc = new Map<string, { id: string; hash: string }>();
    const aptAgreementDoc = new Map<string, { id: string; hash: string }>(); // key = aptId

    async function mkDoc(opts: {
      key: string;
      name: string;
      type: string;
      projectId: string;
      apartmentId: string | null;
      sizeBytes: number;
    }): Promise<{ id: string; hash: string }> {
      const id = randomUUID();
      const r2Key = `documents/${orgId}/demo-${opts.key}.pdf`;
      docsForBytes.push({ r2Key, name: opts.name });
      const contentHash = createHash('sha256').update(`seed-demo-${r2Key}`).digest('hex');
      // PARENT EXCLUSIVITY — an apartment-scoped doc resolves to its project via
      // the apartment's building; it MUST NOT also carry projectId (both-parent
      // double-counts across two projects and breaks the home-KPI ↔ per-project-
      // board reconciliation). Apartment wins → projectId null. Mirrors the
      // CreateDocumentInput refine + production write path.
      const docProjectId = opts.apartmentId ? null : opts.projectId;
      await tx.insert(documents).values({
        id,
        orgId,
        projectId: docProjectId,
        apartmentId: opts.apartmentId,
        name: opts.name,
        type: opts.type,
        mimeType: 'application/pdf',
        sizeBytes: opts.sizeBytes,
        r2Key,
        contentHash,
        uploadedBy: managerId,
        createdAt: d(10),
        updatedAt: d(4),
      });
      docsCreated += 1;
      return { id, hash: contentHash };
    }

    for (let pi = 0; pi < createdProjectIds.length; pi += 1) {
      const pid = createdProjectIds[pi]!;
      const reg = await mkDoc({
        key: `reg-${pi}`,
        name: `תקנון תמ״א 38 — פרויקט ${pi + 1}.pdf`,
        type: 'regulation',
        projectId: pid,
        apartmentId: null,
        sizeBytes: 240_000 + pi * 1_000,
      });
      projectRegulationDoc.set(pid, reg);
      await mkDoc({
        key: `bp-${pi}`,
        name: `תוכנית בנייה — חזית ${pi + 1}.pdf`,
        type: 'blueprint',
        projectId: pid,
        apartmentId: null,
        sizeBytes: 1_100_000 + pi * 5_000,
      });
    }

    // Per-apartment agreements for apts that have signing activity.
    for (const apt of aptRefs) {
      if (apt.status === 'signed' || apt.status === 'meeting') {
        const ag = await mkDoc({
          key: `agr-${apt.aptId.slice(0, 8)}`,
          name: `הסכם דייר — דירה ${apt.number}.pdf`,
          type: 'agreement',
          projectId: apt.projectId,
          apartmentId: apt.aptId,
          sizeBytes: 150_000 + (apartmentsCreated % 50) * 200,
        });
        aptAgreementDoc.set(apt.aptId, ag);
      }
    }

    // ---- 4. Signature requests + signatures ----
    let sigReqs = 0;
    let sigRows = 0;
    let sigSeq = 0;
    const sigBytes = Buffer.from(SIGNATURE_SVG, 'utf8');

    for (const apt of aptRefs) {
      const doc = aptAgreementDoc.get(apt.aptId);
      if (!doc || !apt.primaryOwnerId) continue;
      sigSeq += 1;
      const jti = `seed-demo-sig-${sigSeq}`;
      const createdAt = d(7 + (sigSeq % 5));
      const expiresAt = new Date(createdAt.getTime() + 14 * DAY);

      // signed apts → signed; meeting apts → pending; sprinkle a cancelled.
      let state: 'pending' | 'signed' | 'cancelled';
      if (apt.status === 'signed') state = 'signed';
      else if (sigSeq % 11 === 0) state = 'cancelled';
      else state = 'pending';

      let signedSignatureId: string | null = null;
      if (state === 'signed') {
        const signatureId = randomUUID();
        const signedAt = d(2 + (sigSeq % 4));
        await tx.insert(signatures).values({
          id: signatureId,
          orgId,
          documentId: doc.id,
          ownerId: apt.primaryOwnerId,
          documentHash: doc.hash,
          signatureBlob: sigBytes,
          signatureFormat: 'svg',
          signerIp: '203.0.113.42',
          signerUserAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile',
          sessionId: null,
          authMethod: 'sms_otp',
          signedAt,
        });
        signedSignatureId = signatureId;
        sigRows += 1;
      }

      await tx.insert(signatureRequests).values({
        id: randomUUID(),
        orgId,
        documentId: doc.id,
        ownerId: apt.primaryOwnerId,
        jti,
        status: state,
        expiresAt,
        createdBy: managerId,
        createdAt,
        signedAt: state === 'signed' ? d(2 + (sigSeq % 4)) : null,
        signedSignatureId,
        cancelledAt: state === 'cancelled' ? d(1) : null,
        cancelledBy: state === 'cancelled' ? managerId : null,
      });
      sigReqs += 1;
    }

    // ---- 5. Contractors + shares ----
    const contractorDefs: Array<{
      name: string;
      email: string;
      phone: string;
      specialty: string;
      companyId: string;
      shareProjectIdx: number[];
      perms: SharePermissions;
    }> = [
      {
        name: 'אורבן בנייה בע״מ',
        email: 'office@urban-build.dev',
        phone: '+97236000111',
        specialty: 'קבלן מבצע',
        companyId: '514888001',
        shareProjectIdx: [3, 2], // in_construction + approved
        perms: PERM_FULL,
      },
      {
        name: 'אדריכלי לוין ושות׳',
        email: 'studio@levin-arch.dev',
        phone: '+97236000222',
        specialty: 'אדריכלות',
        companyId: '514888002',
        shareProjectIdx: [1, 0], // gathering_signatures + planning
        perms: PERM_DOCS_ONLY,
      },
      {
        name: 'משרד עו״ד שגב',
        email: 'legal@segev-law.dev',
        phone: '+97236000333',
        specialty: 'ליווי משפטי',
        companyId: '514888003',
        shareProjectIdx: [2], // approved
        perms: PERM_SIGN_VIEW,
      },
    ];
    let contractorsCreated = 0;
    let sharesCreated = 0;
    for (const c of contractorDefs) {
      const contractorId = randomUUID();
      await tx.insert(contractors).values({
        id: contractorId,
        orgId,
        name: c.name,
        contactEmail: c.email,
        contactPhone: c.phone,
        companyId: c.companyId,
        specialty: c.specialty,
        notes: 'דמו — קבלן/ספק לדוגמה.',
        createdBy: managerId,
        createdAt: d(20),
        updatedAt: d(5),
      });
      contractorsCreated += 1;
      for (const idx of c.shareProjectIdx) {
        const pid = createdProjectIds[idx];
        if (!pid) continue;
        await tx.insert(shares).values({
          id: randomUUID(),
          projectId: pid,
          contractorId,
          permissions: c.perms,
          createdBy: managerId,
          lastAccessedAt: d(3),
          createdAt: d(18),
          updatedAt: d(5),
        });
        sharesCreated += 1;
      }
    }

    // ---- 6. Tasks + assignees (some calendar-scheduled) ----
    const taskDefs: Array<{
      title: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
      priority: number;
      projectIdx: number;
      aptIdx?: number;
      scheduledInDays?: number;
      dueInDays?: number;
      assignees: ('manager' | 'agent')[];
      location?: string;
    }> = [
      {
        title: 'פגישת חתימה עם דיירי ויצמן 20',
        status: 'pending',
        priority: 1,
        projectIdx: 1,
        scheduledInDays: 1,
        assignees: ['agent'],
        location: 'ויצמן 20, גבעתיים',
      },
      {
        title: 'סיור בניין — ארלוזורוב 14',
        status: 'in_progress',
        priority: 2,
        projectIdx: 3,
        scheduledInDays: 2,
        assignees: ['agent', 'manager'],
        location: 'ארלוזורוב 14, ת״א',
      },
      {
        title: 'בדיקת מסמכי בעלות — רסקו',
        status: 'pending',
        priority: 2,
        projectIdx: 2,
        dueInDays: 4,
        assignees: ['manager'],
      },
      {
        title: 'תיאום קבלן מבצע',
        status: 'pending',
        priority: 1,
        projectIdx: 3,
        scheduledInDays: 3,
        assignees: ['manager'],
      },
      {
        title: 'מעקב דייר מסרב — נווה שאנן',
        status: 'in_progress',
        priority: 3,
        projectIdx: 5,
        assignees: ['agent'],
      },
      {
        title: 'העלאת תוכניות אדריכליות מעודכנות',
        status: 'completed',
        priority: 2,
        projectIdx: 1,
        assignees: ['agent'],
      },
      {
        title: 'שליחת תזכורת חתימה לדיירים',
        status: 'pending',
        priority: 2,
        projectIdx: 1,
        scheduledInDays: 4,
        assignees: ['agent'],
      },
      {
        title: 'סגירת תיק פרויקט שיכון ותיקים',
        status: 'completed',
        priority: 3,
        projectIdx: 4,
        assignees: ['manager'],
      },
      {
        title: 'פגישת ייעוץ משפטי — מתחם רסקו',
        status: 'pending',
        priority: 1,
        projectIdx: 2,
        scheduledInDays: 5,
        assignees: ['manager'],
        location: 'משרד עו״ד שגב',
      },
      {
        title: 'עדכון סטטוס דירות — ויצמן 22',
        status: 'in_progress',
        priority: 2,
        projectIdx: 1,
        assignees: ['agent'],
      },
    ];
    let tasksCreated = 0;
    let assigneesCreated = 0;
    for (const t of taskDefs) {
      const taskId = randomUUID();
      const projectId = createdProjectIds[t.projectIdx] ?? null;
      await tx.insert(tasks).values({
        id: taskId,
        orgId,
        projectId,
        apartmentId: null,
        title: t.title,
        description: 'דמו — משימה לדוגמה.',
        type: 'general',
        status: t.status,
        priority: t.priority,
        dueAt: t.dueInDays != null ? ahead(t.dueInDays, 17) : null,
        scheduledAt:
          t.scheduledInDays != null ? ahead(t.scheduledInDays, 9 + (tasksCreated % 6)) : null,
        durationMinutes: t.scheduledInDays != null ? 60 : null,
        location: t.location ?? null,
        completedAt: t.status === 'completed' ? d(1) : null,
        completedBy: t.status === 'completed' ? managerId : null,
        createdBy: managerId,
        createdAt: d(8),
        updatedAt: d(2),
      });
      tasksCreated += 1;
      for (const who of t.assignees) {
        await tx.insert(taskAssignees).values({
          id: randomUUID(),
          taskId,
          userId: who === 'agent' ? agentId : managerId,
          assignedBy: managerId,
          notifiedAt: d(7),
        });
        assigneesCreated += 1;
      }
    }

    // ---- 7. Notifications (manager + agent; some unread) ----
    const notifDefs: Array<{
      who: 'manager' | 'agent';
      type:
        | 'task_assigned'
        | 'apartment_status_changed'
        | 'document_uploaded'
        | 'signature_received'
        | 'note_added';
      title: string;
      body: string;
      read: boolean;
    }> = [
      {
        who: 'agent',
        type: 'task_assigned',
        title: 'משימה חדשה שובצה אליך',
        body: 'פגישת חתימה עם דיירי ויצמן 20',
        read: false,
      },
      {
        who: 'manager',
        type: 'signature_received',
        title: 'התקבלה חתימה',
        body: 'דייר חתם על הסכם במתחם רסקו',
        read: false,
      },
      {
        who: 'manager',
        type: 'document_uploaded',
        title: 'מסמך הועלה',
        body: 'תוכנית בנייה — ארלוזורוב 14',
        read: true,
      },
      {
        who: 'agent',
        type: 'apartment_status_changed',
        title: 'סטטוס דירה עודכן',
        body: 'דירה 3 בוויצמן 20 → פגישה',
        read: false,
      },
      {
        who: 'manager',
        type: 'signature_received',
        title: 'התקבלה חתימה',
        body: 'דייר חתם על הסכם בארלוזורוב 16',
        read: true,
      },
      {
        who: 'agent',
        type: 'note_added',
        title: 'הערה נוספה',
        body: 'הערה על דייר מסרב בנווה שאנן',
        read: false,
      },
      {
        who: 'manager',
        type: 'task_assigned',
        title: 'משימה חדשה',
        body: 'בדיקת מסמכי בעלות — רסקו',
        read: true,
      },
      {
        who: 'agent',
        type: 'document_uploaded',
        title: 'מסמך הועלה',
        body: 'תקנון תמ״א 38 — ויצמן 20',
        read: false,
      },
    ];
    let notifsCreated = 0;
    for (let i = 0; i < notifDefs.length; i += 1) {
      const n = notifDefs[i]!;
      await tx.insert(notifications).values({
        id: randomUUID(),
        orgId,
        userId: n.who === 'agent' ? agentId : managerId,
        type: n.type,
        title: n.title,
        body: n.body,
        link: null,
        metadata: {},
        readAt: n.read ? d(1) : null,
        createdAt: d(i % 6),
      });
      notifsCreated += 1;
    }

    // ---- 8. Project assignments (Agent sees "assigned projects") ----
    let assignmentsCreated = 0;
    for (const idx of [1, 3]) {
      // gathering_signatures + in_construction → assign the agent
      const pid = createdProjectIds[idx];
      if (!pid) continue;
      await tx.insert(projectAssignments).values({
        id: randomUUID(),
        projectId: pid,
        userId: agentId,
        roleInProject: 'agent',
        assignedBy: managerId,
        assignedAt: d(15),
      });
      assignmentsCreated += 1;
    }

    return {
      skipped: false as const,
      orgId,
      docsForBytes,
      counts: {
        projects: createdProjectIds.length,
        buildings: buildingsCreated,
        apartments: apartmentsCreated,
        owners: OWNER_COUNT,
        ownerships: ownershipsCreated,
        documents: docsCreated,
        signatureRequests: sigReqs,
        signatures: sigRows,
        contractors: contractorsCreated,
        shares: sharesCreated,
        tasks: tasksCreated,
        taskAssignees: assigneesCreated,
        notifications: notifsCreated,
        projectAssignments: assignmentsCreated,
      },
    };
  });

  if (result.skipped) {
    console.log('[seed-demo] demo data already present (sentinel project found) — nothing to do.');
    return 0;
  }

  // Upload renderable PDF bytes AFTER the tx (storage is not transactional).
  // Real R2 → demo previews open; no R2 → skipped (run the backfill instead).
  const uploaded = await uploadSeedDocBytes(result.docsForBytes);
  if (result.docsForBytes.length > 0) {
    console.log(
      uploaded
        ? `[seed-demo] uploaded renderable PDF bytes for ${result.docsForBytes.length} document(s) to R2.`
        : '[seed-demo] R2 not configured — document bytes NOT uploaded (metadata only). ' +
            'Run `pnpm --filter @emapp/db backfill:doc-bytes` with Infisical to add renderable bytes.',
    );
  }

  console.log('[seed-demo] created rich demo dataset on org alpha-dev:');
  for (const [k, v] of Object.entries(result.counts)) {
    console.log(`  - ${k.padEnd(18)} ${v}`);
  }
  console.log(
    '[seed-demo] login: manager@alpha.dev / DevPassword123!  (agent@alpha.dev sees 2 assigned projects)',
  );
  return 0;
}

const isCli =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main()
    .then(async (code) => {
      await closeAllPools();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error('[seed-demo] failed:', err);
      await closeAllPools();
      process.exit(1);
    });
}

export { main as runSeedDemo };
