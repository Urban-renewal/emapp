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
// PII discipline (D.47 — supersedes the earlier D.40 "own cleartext"):
// the tenant's OWN national_id + phone are MASKED on the wire
// (`•••••••53` / `•••••1234`), consistent with the org-side D.19 masking.
// No cleartext PII crosses the wire anywhere — masked-by-default is the
// cleanest ISO posture and removes the SEC-1 exposure. Other tenants'
// data is unreachable: every query is scoped to `eq(owners.id,
// tenant.sub)` (own row) or `eq(ownerships.ownerId, tenant.sub)` (own
// ownerships → own apartments → own documents/signatures).
// ──────────────────────────────────────────────────────────────────────

/**
 * `GET /portal/me` — the tenant's own owner record.
 *
 * D.47 — `national_id` + `phone` are MASKED (server-side, in-SQL); the
 * cleartext never crosses the wire. Name + email are not D.19 PII and are
 * shown as-is (a resident knows their own name).
 */
export const TenantPortalMeSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  email: z.string().nullable(),
  /** Masked: `•••••••XX` (7 bullets + last 2). Never cleartext (D.47). */
  nationalIdMasked: z.string(),
  /** Masked: `•••••XXXX` (last 4), or null when no phone on file. */
  phoneMasked: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type TenantPortalMe = z.infer<typeof TenantPortalMeSchema>;

/**
 * `PATCH /portal/me` — resident self-update of their OWN contact details
 * (P4 — EMAIL only this slice; see docs/decision-records/
 * P4-resident-self-update-contact.md).
 *
 * `.strict()` is LOAD-BEARING: it rejects any extra key (`phone`,
 * `national_id`, `name`) with a 400. This is the structural enforcement
 * of two invariants at the DTO boundary — (1) national_id is IMMUTABLE,
 * (2) phone change is DEFERRED to its own Gate-6 slice (phone is the
 * SMS-OTP auth factor → changing it must OTP-verify the new number first).
 * So the ONLY writable field is `email`; no mass-assignment surface.
 *
 * `email` is `.nullable()` — a resident may CLEAR their email (set null);
 * the column is nullable `citext`. Trimmed + lowercased to match the
 * `citext` collation and avoid a `" foo@x.com "` round-trip. `max(254)`
 * is the RFC 5321 address limit.
 */
export const PortalUpdateContactSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254).nullable(),
  })
  .strict();
export type PortalUpdateContactDto = z.infer<typeof PortalUpdateContactSchema>;

/**
 * `GET /portal/progress` — AGGREGATE signature progress for each project
 * the tenant has an apartment in. Counts/percentages ONLY — NEVER any
 * other resident's individual data or PII (the scope-critical rule). The
 * resident sees "Project X: 58 of 100 signed (58%)", never who.
 */
export const TenantPortalProgressSchema = z.object({
  projectId: z.string().uuid(),
  projectName: z.string(),
  status: ProjectStatusEnum,
  /** Project-wide signature-request counts (aggregate, no per-owner rows).
   *  `signaturesTotal` is ACTIVE only (`signed + pending`) — cancelled
   *  requests are excluded so they don't dilute the completion %. */
  signaturesSigned: z.number().int().nonnegative(),
  signaturesPending: z.number().int().nonnegative(),
  signaturesTotal: z.number().int().nonnegative(),
});
export type TenantPortalProgress = z.infer<typeof TenantPortalProgressSchema>;

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
