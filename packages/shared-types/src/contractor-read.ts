import { z } from 'zod';

import { ProjectStatusEnum, ProjectTypeEnum } from './project';

// ──────────────────────────────────────────────────────────────────────
// D2-DEF-1 / D.46 — Contractor read-tier wire contracts.
//
// A contractor authenticates with a share-access token (a signed JWT bound
// to ONE `shares` row, audience `emapp-share`) and reads a project scoped
// by the share's JSONB permissions. The read-view is DELIBERATELY narrow:
//
//   - project + buildings + apartments (STRUCTURAL only — NO owner link,
//     NO owner PII, ever)
//   - aggregate signature progress (counts/% — never who signed)
//   - manager-SELECTED documents (metadata + IDOR-safe download)
//
// There is NO owners endpoint and NO owner field anywhere in these shapes —
// "owners-PII OFF" (D.46) is structural, not a runtime flag.
// ──────────────────────────────────────────────────────────────────────

/** A single apartment in the contractor view — STRUCTURAL fields only. */
export const ContractorApartmentSchema = z.object({
  id: z.string().uuid(),
  number: z.string(),
  floor: z.number().nullable(),
  rooms: z.number().nullable(),
  sizeSqm: z.number().nullable(),
  unitType: z.string(),
  entrance: z.string().nullable(),
});
export type ContractorApartment = z.infer<typeof ContractorApartmentSchema>;

export const ContractorBuildingSchema = z.object({
  id: z.string().uuid(),
  address: z.string(),
  city: z.string(),
  /** Cadastral identifiers (gush/helka) — structural, no owner link. */
  block: z.string().nullable(),
  parcel: z.string().nullable(),
  apartments: z.array(ContractorApartmentSchema),
});
export type ContractorBuilding = z.infer<typeof ContractorBuildingSchema>;

/** `GET /contractor/project` — the shared project + its structure. */
export const ContractorProjectViewSchema = z.object({
  project: z.object({
    id: z.string().uuid(),
    name: z.string(),
    status: ProjectStatusEnum,
    type: ProjectTypeEnum,
  }),
  buildings: z.array(ContractorBuildingSchema),
  /** Echoed permission summary so the FE renders only the granted sections
   *  (UX; the BE enforces each endpoint independently). */
  permissions: z.object({
    overview: z.boolean(),
    documents: z.boolean(),
    signatures: z.boolean(),
  }),
});
export type ContractorProjectView = z.infer<typeof ContractorProjectViewSchema>;

/** `GET /contractor/progress` — AGGREGATE signature progress (counts only,
 *  never who/individual — `signatureScopeForShare` is structurally
 *  'aggregate'). */
export const ContractorProgressSchema = z.object({
  signaturesSigned: z.number().int().nonnegative(),
  signaturesPending: z.number().int().nonnegative(),
  /** Active total (signed + pending); cancelled excluded — matches D.46/portal. */
  signaturesTotal: z.number().int().nonnegative(),
});
export type ContractorProgress = z.infer<typeof ContractorProgressSchema>;

/** One row of `GET /contractor/documents` — a manager-SELECTED document
 *  shared with the contractor. Metadata only; download via the dedicated
 *  IDOR-checked endpoint. */
export const ContractorDocumentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  createdAt: z.coerce.date(),
});
export type ContractorDocument = z.infer<typeof ContractorDocumentSchema>;

/** `GET /contractor/documents/:id/download` — a short-lived presigned URL. */
export const ContractorDownloadSchema = z.object({
  url: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
});
export type ContractorDownload = z.infer<typeof ContractorDownloadSchema>;

/** `POST /shares/:id/link` (manager) — mint a share-access link for a share. */
export const ShareLinkSchema = z.object({
  /** The signed share-access token (the credential — delivered out-of-band). */
  token: z.string(),
  /** ISO expiry of the token. */
  expiresAt: z.coerce.date(),
});
export type ShareLink = z.infer<typeof ShareLinkSchema>;
