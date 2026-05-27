import { z } from 'zod';

import { ApartmentStatusEnum } from './apartment';
import { ProjectStatusEnum, ProjectTypeEnum } from './project';

// ──────────────────────────────────────────────────────────────────────
// V11 B.S4 — Tenant Portal own-data view (D.40).
//
// Wire contracts for the 4 endpoints under `/api/v1/portal/*` (audience
// `emapp-tenant`). All scoped to the authenticated tenant's own
// `owner.id` (no list pagination — a tenant typically owns 1 apartment
// and has a handful of docs/signatures, so the simple `{ data: [...] }`
// envelope without keyset cursor is correct here).
//
// PII discipline: tenant sees THEIR OWN cleartext PII per D.40 ("masked
// PII to themselves shown as-is") — they own it, so masking would be
// theatrical. Other tenants' PII is unreachable: every query is scoped
// to `eq(owners.id, tenant.sub)` (own row) or
// `eq(ownerships.ownerId, tenant.sub)` (own ownerships → own
// apartments → own documents/signatures).
// ──────────────────────────────────────────────────────────────────────

/** `GET /portal/me` — the tenant's own owner record (cleartext PII). */
export const TenantPortalMeSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  email: z.string().nullable(),
  nationalId: z.string(),
  phone: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type TenantPortalMe = z.infer<typeof TenantPortalMeSchema>;

/** One row of `GET /portal/apartment` — an apartment the tenant owns,
 *  joined to its building + project for FE display context. */
export const TenantPortalApartmentSchema = z.object({
  apartment: z.object({
    id: z.string().uuid(),
    buildingId: z.string().uuid(),
    number: z.string(),
    floor: z.number().nullable(),
    sizeSqm: z.number().nullable(),
    areaSqm: z.number().nullable(),
    rooms: z.number().nullable(),
    status: ApartmentStatusEnum,
    // unit_type column came in via migration 0035 (D.39, B.S1). Plain
    // string on the output side — the closed enum lives on the WRITE
    // boundary (CreateProjectApartmentInput); reads from a trusted DB
    // don't need to re-validate.
    unitType: z.string(),
    entrance: z.string().nullable(),
  }),
  building: z.object({
    id: z.string().uuid(),
    address: z.string(),
    city: z.string(),
  }),
  project: z.object({
    id: z.string().uuid(),
    name: z.string(),
    status: ProjectStatusEnum,
    type: ProjectTypeEnum,
  }),
  ownership: z.object({
    pct: z.number(),
    role: z.string().nullable(),
  }),
});
export type TenantPortalApartment = z.infer<typeof TenantPortalApartmentSchema>;

/** One row of `GET /portal/documents` — a document attached to one of
 *  the tenant's own apartments. Metadata only — the download itself
 *  goes through the existing `/api/v1/documents/:id/download` flow
 *  (presigned R2 URL, per D.28). */
export const TenantPortalDocumentSchema = z.object({
  id: z.string().uuid(),
  apartmentId: z.string().uuid(),
  name: z.string(),
  type: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  createdAt: z.coerce.date(),
});
export type TenantPortalDocument = z.infer<typeof TenantPortalDocumentSchema>;

/** One row of `GET /portal/signatures` — a signature request where this
 *  tenant is the recipient. NEVER includes the `jti` / signing URL on
 *  the wire (D.12 LAW — the token is delivered out-of-band via SMS and
 *  is the credential itself). The tenant uses the existing public
 *  `/sign/<token>` surface to actually sign. */
export const TenantPortalSignatureSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  documentName: z.string(),
  status: z.enum(['pending', 'signed', 'cancelled']),
  expiresAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  signedAt: z.coerce.date().nullable(),
  cancelledAt: z.coerce.date().nullable(),
});
export type TenantPortalSignature = z.infer<typeof TenantPortalSignatureSchema>;
