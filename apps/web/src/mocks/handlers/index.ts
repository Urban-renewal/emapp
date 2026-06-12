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
  SetOwnershipsInput,
  SignatureRequestSchema,
  SubmitMappingInput,
} from '@emapp/shared-types';
import { http, HttpResponse } from 'msw';

import { SAMPLE_APARTMENTS } from '../samples/apartments';
import { SAMPLE_BUILDINGS } from '../samples/buildings';
import { SAMPLE_DOCUMENTS } from '../samples/documents';
import { SAMPLE_IMPORT_ERRORS, SAMPLE_IMPORTS } from '../samples/imports';
import { SAMPLE_OWNERS } from '../samples/owners';
import { SAMPLE_APARTMENT_OWNERS } from '../samples/ownerships';
import { SAMPLE_PROJECTS } from '../samples/projects';
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
  http.get(`${API}/owners`, () => HttpResponse.json(listEnvelope(SAMPLE_OWNERS))),
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

  // documents
  http.get(`${API}/documents`, () => HttpResponse.json(listEnvelope(SAMPLE_DOCUMENTS))),
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
