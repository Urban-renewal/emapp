/**
 * MSW handlers — mock the BE wire surface for offline FE dev.
 *
 * Doc 05 §10.4 + Doc 11 §2 closure (§v9-P0-1).
 *
 * Convention: handlers ONLY orchestrate the SAMPLE_* fixtures. They
 * don't define data. Same Zod schemas the BE enforces are used at
 * the request-input boundary so form bugs surface in offline mode.
 */
import {
  ApartmentSchema,
  BuildingSchema,
  CreateApartmentInput,
  CreateBuildingInput,
  CreateDocumentInput,
  CreateImportInput,
  CreateOwnerInput,
  CreateProjectInput,
  CreateSignatureRequestInput,
  DocumentSchema,
  ImportJobSchema,
  OwnerSchema,
  ProjectSchema,
  providerPartyForDocType,
  SetOwnershipsInput,
  SignatureRequestSchema,
  SubmitMappingInput,
} from '@emapp/shared-types';
import { http, HttpResponse } from 'msw';

import { SAMPLE_APARTMENTS } from '../samples/apartments';
import { SAMPLE_BUILDINGS } from '../samples/buildings';
import { SAMPLE_CONTRACTORS, SAMPLE_CONTRACTOR_SPECIALTIES } from '../samples/contractors';
import { SAMPLE_DOCUMENTS } from '../samples/documents';
import { SAMPLE_IMPORT_ERRORS, SAMPLE_IMPORTS } from '../samples/imports';
import { SAMPLE_OWNERS } from '../samples/owners';
import { SAMPLE_APARTMENT_OWNERS } from '../samples/ownerships';
import { SAMPLE_PROJECTS } from '../samples/projects';
import {
  SAMPLE_APARTMENT_HOLDOUTS,
  SAMPLE_APARTMENT_SIGNATURE_PROGRESS,
  SAMPLE_SIGNATURE_PROGRESS,
} from '../samples/signature-progress';
import { SAMPLE_SIGNATURE_PULSE } from '../samples/signature-pulse';
import {
  SAMPLE_SIGNATURE_DELIVERY,
  SAMPLE_SIGNATURE_REQUESTS,
} from '../samples/signature-requests';
import { SAMPLE_ME } from '../samples/users';

const API = '/api/v1';
const PAGE_25 = { limit: 25, cursor: null, has_more: false };

/** Build a D.16 list envelope. */
function listEnvelope<T>(items: T[]) {
  return { data: items, page: PAGE_25 };
}
/** Build a D.16 single envelope. */
function dataEnvelope<T>(item: T) {
  return { data: item };
}
/** Build a D.16 error envelope. */
function errorEnvelope(code: string, status: number, details?: unknown) {
  return HttpResponse.json({ error: { code, ...(details ? { details } : {}) } }, { status });
}

export const handlers = [
  // /me + auth
  http.get(`${API}/me`, () => HttpResponse.json(dataEnvelope(SAMPLE_ME))),
  http.post(`${API}/auth/logout`, () => HttpResponse.json(dataEnvelope({ ok: true }))),
  http.post(`${API}/auth/refresh`, () => HttpResponse.json(dataEnvelope({ ok: true }))),

  // E2 Wave-2 B1 — org signature pulse (the board-first home's data feed).
  // The home (mission-control island) fetches this on mount; without a handler
  // the offline home + the §P0-3 console guard would 404. Returns the ranked
  // SAMPLE fixture (attention already most-urgent-first, mirroring rankAttention).
  http.get(`${API}/org/signature-pulse`, () =>
    HttpResponse.json(dataEnvelope(SAMPLE_SIGNATURE_PULSE)),
  ),

  // projects
  http.get(`${API}/projects`, () => HttpResponse.json(listEnvelope(SAMPLE_PROJECTS))),
  http.post(`${API}/projects`, async ({ request }) => {
    const body = await request.json();
    const parsed = CreateProjectInput.safeParse(body);
    if (!parsed.success) {
      return errorEnvelope('validation_error', 400, parsed.error.flatten().fieldErrors);
    }
    const project = ProjectSchema.parse({
      ...SAMPLE_PROJECTS[0],
      id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzz1',
      name: parsed.data.name,
      type: parsed.data.type,
      status: parsed.data.status ?? 'planning',
      description: parsed.data.description ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return HttpResponse.json(dataEnvelope(project), { status: 201 });
  }),
  http.get(`${API}/projects/:id`, ({ params }) => {
    const p = SAMPLE_PROJECTS.find((x) => x.id === params['id']);
    return p ? HttpResponse.json(dataEnvelope(p)) : errorEnvelope('not_found', 404);
  }),
  // E2 Wave-1 B5 — project PATCH with the status state-machine + optimistic-
  // concurrency error surface. The handler is BEHAVIOUR-DRIVEN so the e2e can
  // deterministically exercise each error path the BE may emit:
  //   - status 'completed'  → invalid_status_transition (illegal edge from a
  //                           `planning` sample project)
  //   - status 'approved'   → threshold_not_met (consent target not crossed)
  //   - expectedUpdatedAt
  //     === STALE sentinel   → stale_write (someone else edited in between)
  // Anything else echoes the patched project with a FRESH `updatedAt` so the
  // happy path (and version chaining) is exercised too.
  http.patch(`${API}/projects/:id`, async ({ request, params }) => {
    const p = SAMPLE_PROJECTS.find((x) => x.id === params['id']);
    if (!p) return errorEnvelope('not_found', 404);
    const body = (await request.json()) as {
      status?: string;
      expectedUpdatedAt?: string;
      name?: string;
    };
    if (body.status === 'completed') {
      return errorEnvelope('invalid_status_transition', 409, {
        from: p.status,
        to: 'completed',
      });
    }
    if (body.status === 'approved') {
      return errorEnvelope('threshold_not_met', 409, { from: p.status, to: 'approved' });
    }
    // The fixed STALE sentinel the e2e sends to force a concurrency conflict.
    if (body.expectedUpdatedAt === '2000-01-01T00:00:00.000Z') {
      return errorEnvelope('stale_write', 409);
    }
    const project = ProjectSchema.parse({
      ...p,
      ...(body.name ? { name: body.name } : {}),
      ...(body.status ? { status: body.status } : {}),
      updatedAt: new Date(),
    });
    return HttpResponse.json(dataEnvelope(project));
  }),
  http.delete(`${API}/projects/:id`, () => new HttpResponse(null, { status: 204 })),

  // V11 A.S15 — export endpoint stub (B.S10 contract). Returns a tiny
  // empty-xlsx byte sequence (the 4 bytes "PK\x03\x04" is the ZIP magic
  // header used by xlsx) so the FE's blob + download path can be
  // exercised offline. The real BE response is a streaming xlsx with
  // `Content-Disposition: attachment; filename="<project>.xlsx"`; this
  // mock mirrors that header so the FE filename parser is also exercised.
  http.get(`${API}/projects/:id/export`, ({ request, params }) => {
    const url = new URL(request.url);
    const format = url.searchParams.get('format');
    if (format !== 'xlsx') {
      return errorEnvelope('validation_error', 400);
    }
    const p = SAMPLE_PROJECTS.find((x) => x.id === params['id']);
    if (!p) return errorEnvelope('not_found', 404);
    // Smallest legal zip header — sufficient for the FE blob round-trip
    // smoke. Real xlsx parsing isn't tested here (BE concern, B.S8).
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    return new HttpResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="project-${p.id}.xlsx"`,
      },
    });
  }),

  // E2 Wave-2 E2.2-S3 — "תמונת מצב" board reads. NO PII on the board/apartments
  // wire; only the HOLDOUTS surface carries owner NAMES (gated + audited on the
  // BE). Registered MORE-SPECIFIC path FIRST so `/holdouts` wins over `/apartments`.
  http.get(
    `${API}/projects/:id/signature-progress/apartments/:apartmentId/holdouts`,
    ({ params }) => {
      // Offline default: return the named holdouts for the partial apartment;
      // any other apartment id yields an empty list (everyone signed). This
      // mirrors the live `data.holdouts` envelope. The view_owner_pii gate +
      // audit are BE concerns; offline always "has" the capability.
      const aptId = String(params['apartmentId']);
      const holdouts =
        aptId === 'cccccccc-cccc-cccc-cccc-ccccccccccc2' ? SAMPLE_APARTMENT_HOLDOUTS : [];
      return HttpResponse.json(dataEnvelope({ holdouts }));
    },
  ),
  http.get(`${API}/projects/:id/signature-progress/apartments`, () =>
    HttpResponse.json(dataEnvelope(SAMPLE_APARTMENT_SIGNATURE_PROGRESS)),
  ),
  http.get(`${API}/projects/:id/signature-progress`, () =>
    HttpResponse.json(dataEnvelope(SAMPLE_SIGNATURE_PROGRESS)),
  ),

  // DH2 (V13) — ADVISORY project document-checklist (S2 surfaces it in the
  // project zoom-in). Self-consistent with SAMPLE_DOCUMENTS + the cockpit
  // board-completeness stub: PROJECT_A ("מתחם הרצל 12", tama38) has agreement +
  // land_registry but no blueprint → blueprint missing; PROJECT_B ("רוטשילד 8",
  // pinui_binui) has only a blueprint → agreement+land_registry+regulation
  // missing. NO PII — doc-type keys + present booleans + counts only.
  http.get(`${API}/projects/:id/document-checklist`, ({ params }) => {
    const id = String(params['id']);
    let items: { type: string; present: boolean }[];
    let meta: { projectType: string; track: 'tama38' | 'pinui_binui' | 'default' };
    if (id === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2') {
      meta = { projectType: 'pinui_binui', track: 'pinui_binui' };
      items = [
        { type: 'agreement', present: false },
        { type: 'land_registry', present: false },
        { type: 'blueprint', present: true },
        { type: 'regulation', present: false },
      ];
    } else {
      meta = { projectType: 'tama38_2', track: 'tama38' };
      items = [
        { type: 'agreement', present: true },
        { type: 'land_registry', present: true },
        { type: 'blueprint', present: false },
      ];
    }
    const totalCount = items.length;
    const presentCount = items.filter((i) => i.present).length;
    return HttpResponse.json(
      dataEnvelope({
        projectId: id,
        projectType: meta.projectType,
        track: meta.track,
        items,
        presentCount,
        totalCount,
        completionPct: totalCount > 0 ? Math.round((presentCount / totalCount) * 100) : 0,
        advisory: true,
      }),
    );
  }),

  // buildings (nested under project)
  http.get(`${API}/projects/:projectId/buildings`, ({ params }) => {
    const items = SAMPLE_BUILDINGS.filter((b) => b.projectId === params['projectId']);
    return HttpResponse.json(listEnvelope(items));
  }),
  http.post(`${API}/projects/:projectId/buildings`, async ({ request, params }) => {
    const body = await request.json();
    const parsed = CreateBuildingInput.safeParse(body);
    if (!parsed.success) {
      return errorEnvelope('validation_error', 400, parsed.error.flatten().fieldErrors);
    }
    const b = BuildingSchema.parse({
      ...SAMPLE_BUILDINGS[0],
      id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzb1',
      projectId: String(params['projectId']),
      address: parsed.data.address,
      city: parsed.data.city,
      block: parsed.data.block ?? null,
      parcel: parsed.data.parcel ?? null,
      subparcel: parsed.data.subparcel ?? null,
      aptCount: parsed.data.aptCount ?? 0,
      notes: parsed.data.notes ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return HttpResponse.json(dataEnvelope(b), { status: 201 });
  }),
  http.get(`${API}/buildings/:id`, ({ params }) => {
    const b = SAMPLE_BUILDINGS.find((x) => x.id === params['id']);
    return b ? HttpResponse.json(dataEnvelope(b)) : errorEnvelope('not_found', 404);
  }),
  http.delete(`${API}/buildings/:id`, () => new HttpResponse(null, { status: 204 })),

  // apartments (nested under building)
  http.get(`${API}/buildings/:buildingId/apartments`, ({ params }) => {
    const items = SAMPLE_APARTMENTS.filter((a) => a.buildingId === params['buildingId']);
    return HttpResponse.json(listEnvelope(items));
  }),
  http.post(`${API}/buildings/:buildingId/apartments`, async ({ request, params }) => {
    const body = await request.json();
    const parsed = CreateApartmentInput.safeParse(body);
    if (!parsed.success) {
      return errorEnvelope('validation_error', 400, parsed.error.flatten().fieldErrors);
    }
    const a = ApartmentSchema.parse({
      ...SAMPLE_APARTMENTS[0],
      id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzza1',
      buildingId: String(params['buildingId']),
      number: parsed.data.number,
      floor: parsed.data.floor ?? null,
      sizeSqm: parsed.data.sizeSqm ?? null,
      rooms: parsed.data.rooms ?? null,
      status: parsed.data.status ?? 'pending',
      notes: parsed.data.notes ?? null,
      statusChangedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return HttpResponse.json(dataEnvelope(a), { status: 201 });
  }),
  http.get(`${API}/apartments/:id`, ({ params }) => {
    const a = SAMPLE_APARTMENTS.find((x) => x.id === params['id']);
    return a ? HttpResponse.json(dataEnvelope(a)) : errorEnvelope('not_found', 404);
  }),
  http.delete(`${API}/apartments/:id`, () => new HttpResponse(null, { status: 204 })),

  // owners
  http.get(`${API}/owners`, ({ request }) => {
    // B2 — honor the `needsAttention` flag offline so the chip narrows the
    // sample list too (pendingSignatureCount > 0), faithful to the BE WHERE.
    const url = new URL(request.url);
    const needsAttention = url.searchParams.get('needsAttention') === 'true';
    const rows = needsAttention
      ? SAMPLE_OWNERS.filter((o) => o.pendingSignatureCount > 0)
      : SAMPLE_OWNERS;
    return HttpResponse.json(listEnvelope(rows));
  }),
  http.post(`${API}/owners`, async ({ request }) => {
    const body = await request.json();
    const parsed = CreateOwnerInput.safeParse(body);
    if (!parsed.success) {
      return errorEnvelope('validation_error', 400, parsed.error.flatten().fieldErrors);
    }
    const o = OwnerSchema.parse({
      ...SAMPLE_OWNERS[0],
      id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzo1',
      name: parsed.data.name ?? null,
      // Mask the national_id with bullets + last 2 chars (mimic the
      // server's masking exactly so the wire shape is faithful). A shell
      // owner has no national_id → null mask.
      nationalIdMasked: parsed.data.national_id
        ? `${'•'.repeat(7)}${parsed.data.national_id.slice(-2)}`
        : null,
      phoneMasked: parsed.data.phone ? `${'•'.repeat(5)}${parsed.data.phone.slice(-4)}` : null,
      email: parsed.data.email ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return HttpResponse.json(dataEnvelope(o), { status: 201 });
  }),
  http.post(`${API}/owners/search`, () => HttpResponse.json(dataEnvelope(SAMPLE_OWNERS[0]))),
  // B1 — owner NAME search (GET /owners/search). Faithfully filters the masked
  // SAMPLE_OWNERS by the `q` name substring (case-insensitive) + the B2
  // `needsAttention` flag (pendingSignatureCount > 0), returning the SAME
  // {data,page} list envelope as GET /owners so offline + samples stay green.
  // Registered BEFORE `/owners/:id` (more-specific path wins).
  http.get(`${API}/owners/search`, ({ request }) => {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const needsAttention = url.searchParams.get('needsAttention') === 'true';
    const rows = SAMPLE_OWNERS.filter((o) => {
      const nameHit = q.length === 0 || (o.name ?? '').toLowerCase().includes(q);
      const attentionHit = !needsAttention || o.pendingSignatureCount > 0;
      return nameHit && attentionHit;
    });
    return HttpResponse.json(listEnvelope(rows));
  }),
  // S3d — owner → projects surfacing. Lean PROJECT summaries (id/name/type/
  // status), no owner PII. Registered BEFORE `/owners/:id` (more-specific path).
  http.get(`${API}/owners/:id/projects`, () =>
    HttpResponse.json(
      dataEnvelope(
        SAMPLE_PROJECTS.map((p) => ({ id: p.id, name: p.name, type: p.type, status: p.status })),
      ),
    ),
  ),
  http.get(`${API}/owners/:id`, ({ params }) => {
    const o = SAMPLE_OWNERS.find((x) => x.id === params['id']);
    return o ? HttpResponse.json(dataEnvelope(o)) : errorEnvelope('not_found', 404);
  }),
  http.delete(`${API}/owners/:id`, () => new HttpResponse(null, { status: 204 })),

  // contractors — C-1 "findable at scale". The list honors the server-side
  // `q` (name substring, case-insensitive) + `specialty` (exact) filters so the
  // offline FE exercises the SAME find-by-name + filter-by-specialty flow as
  // live, and returns the `facets.specialties` field (whole-org distinct
  // specialties) the FE's data-derived chips read. The facet is NOT page/filter
  // scoped (mirrors the BE) — it always reflects every active specialty.
  http.get(`${API}/contractors`, ({ request }) => {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const specialty = url.searchParams.get('specialty');
    let items = SAMPLE_CONTRACTORS.filter((c) => c.archivedAt === null);
    if (q) items = items.filter((c) => c.name.toLowerCase().includes(q));
    if (specialty) items = items.filter((c) => c.specialty === specialty);
    return HttpResponse.json({
      data: items,
      facets: { specialties: SAMPLE_CONTRACTOR_SPECIALTIES },
      page: PAGE_25,
    });
  }),
  http.get(`${API}/contractors/:id`, ({ params }) => {
    const c = SAMPLE_CONTRACTORS.find((x) => x.id === params['id']);
    return c ? HttpResponse.json(dataEnvelope(c)) : errorEnvelope('not_found', 404);
  }),
  http.patch(`${API}/contractors/:id`, async ({ request, params }) => {
    const c = SAMPLE_CONTRACTORS.find((x) => x.id === params['id']);
    if (!c) return errorEnvelope('not_found', 404);
    const body = (await request.json()) as Partial<typeof c>;
    return HttpResponse.json(dataEnvelope({ ...c, ...body, updatedAt: new Date() }));
  }),
  http.delete(`${API}/contractors/:id`, () => new HttpResponse(null, { status: 204 })),

  // ownerships
  http.get(`${API}/apartments/:apartmentId/owners`, () =>
    HttpResponse.json(listEnvelope(SAMPLE_APARTMENT_OWNERS)),
  ),
  http.put(`${API}/apartments/:apartmentId/ownerships`, async ({ request }) => {
    const body = await request.json();
    const parsed = SetOwnershipsInput.safeParse(body);
    if (!parsed.success) {
      return errorEnvelope('ownership_sum_invalid', 400, parsed.error.flatten().fieldErrors);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // documents — honor projectId / apartmentId / archived so the project zoom-in
  // and the active/archived toggle behave faithfully offline (Phase 2a).
  http.get(`${API}/documents`, ({ request }) => {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('projectId');
    const apartmentId = url.searchParams.get('apartmentId');
    const archived = url.searchParams.get('archived') === 'true';
    let items = SAMPLE_DOCUMENTS.filter((d) =>
      archived ? d.archivedAt !== null : d.archivedAt === null,
    );
    if (projectId) items = items.filter((d) => d.projectId === projectId);
    if (apartmentId) items = items.filter((d) => d.apartmentId === apartmentId);
    return HttpResponse.json(listEnvelope(items));
  }),
  // Binder slice 2 — PARTY-BINDER board completeness (server-computed). Declared
  // BEFORE the `/documents/:id` handler so the literal path isn't matched as :id.
  // A small, self-consistent offline shape: owner partially met, contractor met,
  // architect outstanding; counts + type keys only (no PII).
  // Phase 2a — the per-party rollup carries the WHOLE-BOARD `total` / `latestType`
  // / `latestCreatedAt` so the board cards show truthful counts offline (not a
  // page slice). Self-consistent with SAMPLE_DOCUMENTS (owner has a land_registry,
  // contractor 2 agreements, architect a blueprint, appraiser a survey). Counts +
  // type keys only — no PII.
  http.get(`${API}/documents/board-completeness`, () =>
    HttpResponse.json(
      dataEnvelope({
        byParty: [
          {
            party: 'owner',
            required: 2,
            received: 1,
            isComplete: false,
            hasRequirement: true,
            missingTypes: [{ type: 'id_document' }],
            total: 1,
            latestType: 'land_registry',
            latestCreatedAt: new Date('2026-05-10T08:00:00Z'),
          },
          {
            party: 'appraiser',
            required: 0,
            received: 0,
            isComplete: false,
            hasRequirement: false,
            missingTypes: [],
            total: 1,
            latestType: 'survey',
            latestCreatedAt: new Date('2026-05-14T12:00:00Z'),
          },
          {
            party: 'architect',
            required: 2,
            received: 1,
            isComplete: false,
            hasRequirement: true,
            missingTypes: [{ type: 'floor_plan' }],
            total: 1,
            latestType: 'blueprint',
            latestCreatedAt: new Date('2026-05-12T11:00:00Z'),
          },
          {
            party: 'municipality',
            required: 0,
            received: 0,
            isComplete: false,
            hasRequirement: false,
            missingTypes: [],
            total: 0,
            latestType: null,
            latestCreatedAt: null,
          },
          {
            party: 'contractor',
            required: 2,
            received: 2,
            isComplete: true,
            hasRequirement: true,
            missingTypes: [],
            total: 2,
            latestType: 'agreement',
            latestCreatedAt: new Date('2026-05-02T09:00:00Z'),
          },
          {
            party: 'lawyer',
            required: 1,
            received: 0,
            isComplete: false,
            hasRequirement: true,
            missingTypes: [{ type: 'regulation' }],
            total: 0,
            latestType: null,
            latestCreatedAt: null,
          },
          {
            party: 'supervisor',
            required: 0,
            received: 0,
            isComplete: false,
            hasRequirement: false,
            missingTypes: [],
            total: 0,
            latestType: null,
            latestCreatedAt: null,
          },
          {
            party: 'surveyor',
            required: 0,
            received: 0,
            isComplete: false,
            hasRequirement: false,
            missingTypes: [],
            total: 0,
            latestType: null,
            latestCreatedAt: null,
          },
          {
            party: 'other',
            required: 0,
            received: 0,
            isComplete: false,
            hasRequirement: false,
            missingTypes: [],
            total: 0,
            latestType: null,
            latestCreatedAt: null,
          },
        ],
        unmetParties: ['owner', 'architect', 'lawyer'],
        hasAnyRequirement: true,
        allRequirementsMet: false,
        // S2 (org cockpit) — the project-attention axis. Self-consistent with
        // SAMPLE_DOCUMENTS: PROJECT_A ("מתחם הרצל 12") has agreement+land_registry
        // but no blueprint → missing blueprint (architect); PROJECT_B
        // ("רוטשילד 8") has only a blueprint → missing agreement+land_registry.
        // Counts + type/party keys + the project NAME only (no owner PII).
        projectsBehind: [
          {
            projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
            projectName: 'רוטשילד 8',
            coreRequired: 3,
            coreReceived: 1,
            missing: [
              { type: 'agreement', party: 'contractor' },
              { type: 'land_registry', party: 'owner' },
            ],
          },
          {
            projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
            projectName: 'מתחם הרצל 12',
            coreRequired: 3,
            coreReceived: 2,
            missing: [{ type: 'blueprint', party: 'architect' }],
          },
        ],
        projectsWithRequirement: 2,
        projectsBehindTotal: 2,
        projectsBehindCapped: false,
      }),
    ),
  ),
  // Phase 2a — server-side document search. Filters SAMPLE_DOCUMENTS by the name
  // substring `q` (required) + optional `party` (via providerPartyForDocType) +
  // `projectId` + `archived`. Declared BEFORE `/documents/:id` so the literal
  // "search" path is not captured as :id. Returns the same { data, page } envelope.
  http.get(`${API}/documents/search`, ({ request }) => {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const party = url.searchParams.get('party');
    const projectId = url.searchParams.get('projectId');
    const archived = url.searchParams.get('archived') === 'true';
    let items = SAMPLE_DOCUMENTS.filter((d) =>
      archived ? d.archivedAt !== null : d.archivedAt === null,
    );
    if (q) items = items.filter((d) => d.name.toLowerCase().includes(q));
    if (party) items = items.filter((d) => providerPartyForDocType(d.type) === party);
    if (projectId) items = items.filter((d) => d.projectId === projectId);
    return HttpResponse.json(listEnvelope(items));
  }),
  // S3 — DH3 classify (suggest-only). A tiny offline heuristic over the filename
  // so the generic dropzone gets a realistic suggestion in MSW mode. Declared
  // BEFORE `/documents` POST + `/documents/:id` (literal path, no :id capture).
  http.post(`${API}/documents/classify`, async ({ request }) => {
    const body = (await request.json()) as { filename?: string };
    const name = (body.filename ?? '').toLowerCase();
    let docType: string | null = null;
    let confidence = 0;
    let reason = 'none';
    if (/(נסח|טאבו|tabu|land)/.test(name)) {
      docType = 'land_registry';
      confidence = 0.92;
      reason = 'filename_tabu';
    } else if (/(הסכם|agreement|contract|חוזה)/.test(name)) {
      docType = 'agreement';
      confidence = 0.7;
      reason = 'filename_agreement';
    } else if (/(תקנון|regulation)/.test(name)) {
      docType = 'regulation';
      confidence = 0.6;
      reason = 'filename_regulation';
    }
    return HttpResponse.json(
      dataEnvelope({
        suggestions: docType ? [{ docType, confidence, signal: 'filename', reason }] : [],
        suggestOnly: true,
      }),
    );
  }),
  // S3 — DH4 dedup-check (read-only). Offline: never a duplicate (the FE then
  // proceeds with the normal upload path).
  http.post(`${API}/documents/dedup-check`, () =>
    HttpResponse.json(dataEnvelope({ duplicates: [], hasDuplicate: false })),
  ),
  http.post(`${API}/documents`, async ({ request }) => {
    const body = await request.json();
    // v9-post-audit-SOLID-6 closure — parse against the same schema
    // the BE pipe enforces so form bugs surface in offline mode.
    const parsed = CreateDocumentInput.safeParse(body);
    if (!parsed.success) {
      return errorEnvelope('validation_error', 400, parsed.error.flatten().fieldErrors);
    }
    const doc = DocumentSchema.parse({
      ...SAMPLE_DOCUMENTS[0],
      id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzd1',
      name: parsed.data.name,
      type: parsed.data.type,
      mimeType: parsed.data.mimeType,
      sizeBytes: parsed.data.sizeBytes,
      contentHash: parsed.data.contentHash,
      projectId: parsed.data.projectId ?? null,
      apartmentId: parsed.data.apartmentId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // 7d — SENSITIVE docs (id_document/financial by type, or explicit
    // sensitive:true) get NO presigned PUT; bytes go through the API
    // content path. Mirrors documents.service.ts so the offline FE
    // exercises the same branch decision.
    const sensitive =
      parsed.data.type === 'id_document' ||
      parsed.data.type === 'financial' ||
      parsed.data.sensitive === true;
    if (sensitive) {
      return HttpResponse.json(
        dataEnvelope({
          document: doc,
          uploadUrl: null,
          uploadExpiresInSeconds: null,
          contentUploadPath: `/api/v1/documents/${doc.id}/content`,
        }),
        { status: 201 },
      );
    }
    return HttpResponse.json(
      dataEnvelope({
        document: doc,
        uploadUrl: 'https://r2.mock/upload?sig=MOCK',
        uploadExpiresInSeconds: 300,
      }),
      { status: 201 },
    );
  }),
  // 7d — sensitive content upload (raw octet-stream body). The real route
  // integrity-checks + scans + encrypts; offline we just acknowledge.
  http.post(`${API}/documents/:id/content`, () =>
    HttpResponse.json(dataEnvelope({ uploaded: true })),
  ),
  http.get(`${API}/documents/:id`, ({ params }) => {
    const d = SAMPLE_DOCUMENTS.find((x) => x.id === params['id']);
    return d ? HttpResponse.json(dataEnvelope(d)) : errorEnvelope('not_found', 404);
  }),
  http.get(`${API}/documents/:id/download`, () =>
    HttpResponse.json(
      dataEnvelope({ url: 'https://r2.mock/download?sig=MOCK', expiresInSeconds: 120 }),
    ),
  ),
  http.post(`${API}/documents/:id/finalize`, ({ params }) => {
    const d = SAMPLE_DOCUMENTS.find((x) => x.id === params['id']);
    return d ? HttpResponse.json(dataEnvelope(d)) : errorEnvelope('not_found', 404);
  }),
  http.delete(`${API}/documents/:id`, () => new HttpResponse(null, { status: 204 })),

  // imports (D.34) — 3-phase create→upload→start + SSE stream + mapping
  http.get(`${API}/imports`, () => HttpResponse.json(listEnvelope(SAMPLE_IMPORTS))),
  http.get(`${API}/imports/:id`, ({ params }) => {
    const i = SAMPLE_IMPORTS.find((x) => x.id === params['id']);
    return i ? HttpResponse.json(dataEnvelope(i)) : errorEnvelope('not_found', 404);
  }),
  http.post(`${API}/imports`, async ({ request }) => {
    const body = await request.json();
    const parsed = CreateImportInput.safeParse(body);
    if (!parsed.success) {
      return errorEnvelope('validation_error', 400, parsed.error.flatten().fieldErrors);
    }
    const importRow = ImportJobSchema.parse({
      ...SAMPLE_IMPORTS[0],
      id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzi1',
      projectId: parsed.data.projectId,
      fileName: parsed.data.fileName,
      fileSizeBytes: parsed.data.fileSizeBytes,
      status: 'queued',
      dryRun: parsed.data.dryRun ?? false,
      totalRows: null,
      processedRows: 0,
      okRows: 0,
      failedRows: 0,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return HttpResponse.json(
      dataEnvelope({
        import: importRow,
        uploadUrl: 'https://r2.mock/imports/upload?sig=MOCK',
        uploadExpiresInSeconds: 300,
      }),
      { status: 201 },
    );
  }),
  http.post(`${API}/imports/:id/start`, ({ params }) => {
    const i = SAMPLE_IMPORTS.find((x) => x.id === params['id']);
    return i
      ? HttpResponse.json(dataEnvelope(i), { status: 202 })
      : errorEnvelope('not_found', 404);
  }),
  http.post(`${API}/imports/:id/mapping`, async ({ request, params }) => {
    const body = await request.json();
    const parsed = SubmitMappingInput.safeParse(body);
    if (!parsed.success) {
      return errorEnvelope('validation_error', 400, parsed.error.flatten().fieldErrors);
    }
    const i = SAMPLE_IMPORTS.find((x) => x.id === params['id']);
    if (!i) return errorEnvelope('not_found', 404);
    return HttpResponse.json(
      dataEnvelope({
        import: { ...i, status: 'queued' as const, updatedAt: new Date() },
        templateId: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzt1',
      }),
    );
  }),
  http.delete(`${API}/imports/:id`, ({ params }) => {
    const i = SAMPLE_IMPORTS.find((x) => x.id === params['id']);
    return i ? HttpResponse.json(dataEnvelope(i)) : errorEnvelope('not_found', 404);
  }),
  http.get(`${API}/imports/:id/errors`, () =>
    HttpResponse.json(listEnvelope(SAMPLE_IMPORT_ERRORS)),
  ),
  // SSE — single 'end' frame is enough for offline UI; the live
  // wire produces many 'progress' frames in real-time.
  http.get(`${API}/imports/:id/stream`, ({ params }) => {
    const id = String(params['id']);
    const i = SAMPLE_IMPORTS.find((x) => x.id === id);
    if (!i) return errorEnvelope('not_found', 404);
    const frame = `data: ${JSON.stringify({ event: 'end', data: { id, status: i.status } })}\n\n`;
    return new HttpResponse(frame, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }),

  // signature-requests (D.12 LAW) — Manager side
  http.get(`${API}/signature-requests`, ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const items = status
      ? SAMPLE_SIGNATURE_REQUESTS.filter((r) => r.status === status)
      : SAMPLE_SIGNATURE_REQUESTS;
    return HttpResponse.json(listEnvelope(items));
  }),
  http.get(`${API}/signature-requests/:id`, ({ params }) => {
    const r = SAMPLE_SIGNATURE_REQUESTS.find((x) => x.id === params['id']);
    return r ? HttpResponse.json(dataEnvelope(r)) : errorEnvelope('not_found', 404);
  }),
  http.post(`${API}/signature-requests`, async ({ request }) => {
    const body = await request.json();
    const parsed = CreateSignatureRequestInput.safeParse(body);
    if (!parsed.success) {
      return errorEnvelope('validation_error', 400, parsed.error.flatten().fieldErrors);
    }
    const requestRow = SignatureRequestSchema.parse({
      ...SAMPLE_SIGNATURE_REQUESTS[0],
      id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzs1',
      documentId: parsed.data.documentId,
      ownerId: parsed.data.ownerId,
      status: 'pending',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      signedAt: null,
      signedSignatureId: null,
      cancelledAt: null,
      cancelledBy: null,
    });
    return HttpResponse.json(
      dataEnvelope({
        request: requestRow,
        signUrl: `https://app.mock/sign/MOCK_JWT_${requestRow.id}`,
        delivery: SAMPLE_SIGNATURE_DELIVERY,
      }),
      { status: 201 },
    );
  }),
  http.post(`${API}/signature-requests/:id/cancel`, ({ params }) => {
    const r = SAMPLE_SIGNATURE_REQUESTS.find((x) => x.id === params['id']);
    if (!r) return errorEnvelope('not_found', 404);
    if (r.status === 'signed') return errorEnvelope('signature_request_already_signed', 409);
    const cancelled = { ...r, status: 'cancelled' as const, cancelledAt: new Date() };
    return HttpResponse.json(dataEnvelope(cancelled));
  }),

  // S10 — public sign endpoints (D.12 LAW). Anti-enumeration: every
  // failure returns generic 401 invalid_token. In MSW we return the
  // preview for ANY token-shaped path so the offline page renders.
  http.get(`${API}/sign/:token`, ({ params }) => {
    const token = String(params['token']);
    // Lazy JWT-shape check — three base64url segments separated by `.`.
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      return errorEnvelope('invalid_token', 401);
    }
    return HttpResponse.json(
      dataEnvelope({
        document: {
          name: 'הסכם רוב 80% — תמ"א 38/2.pdf',
          downloadUrl: 'https://r2.mock/sign/preview?sig=MOCK',
        },
        owner: { name: 'ישראל ישראלי' },
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        // P0.C2 — configurable PII-processing privacy notice (offline default).
        consentNotice: {
          text: 'בעת החתימה, פרטיך האישיים נאספים ומעובדים לצורך ניהול הליך ההתחדשות העירונית, בהתאם לחוק הגנת הפרטיות.',
          version: 'v1',
          requireExplicitConsent: false,
        },
      }),
    );
  }),
  http.post(`${API}/sign/:token`, async ({ request }) => {
    const body = (await request.json()) as { signatureSvg?: unknown };
    // Mirror BE bounds: 50-262144, starts with <svg ends with </svg>.
    const svg = typeof body.signatureSvg === 'string' ? body.signatureSvg : '';
    if (svg.length < 50 || svg.length > 262_144 || !/^<svg[\s\S]*<\/svg>$/i.test(svg)) {
      return errorEnvelope('invalid_token', 401);
    }
    return HttpResponse.json(dataEnvelope({ signedAt: new Date() }));
  }),
];
