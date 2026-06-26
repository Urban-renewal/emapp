import { z } from 'zod';

import { DOCUMENT_PARTY_VALUES, type DocumentParty } from './document';

// X-S2 / X-S3 (V13) — canonical external_share contract (Doc 11 SoT).
//
// The generalized, party-TYPED external-sharing grant: a developer / lawyer /
// bank / supervisor / appraiser / surveyor / committee / special-admin granted
// a NARROWED-from-ceiling read over a project / building / apartment set.
//
// `ExternalSharePermissionsSchema` is BYTE-EQUIVALENT to the DB-side
// `ExternalSharePermissions` interface in packages/db/src/schema/
// external-share.ts (same supersession/equivalence posture as share.ts).
// Every object is `.strict()` — unknown keys are REJECTED (fail-closed).

export const ExternalSharePartyTypeSchema = z.enum([
  'developer',
  'tenant_lawyer',
  'developer_lawyer',
  'bank',
  'supervisor',
  'appraiser',
  'surveyor',
  'committee',
  'special_admin',
]);
export type ExternalSharePartyType = z.infer<typeof ExternalSharePartyTypeSchema>;

export const ExternalShareScopeTypeSchema = z.enum(['project', 'building', 'apartment']);
export type ExternalShareScopeType = z.infer<typeof ExternalShareScopeTypeSchema>;

// W-4.1 — how a grant's invite reaches the recipient. `manual_link` is the
// ONLY safe default and the ONLY channel permitted when the binder→share
// bridge yields `null` (no auto-mintable party type): the manager copies a
// link out-of-band, nothing is auto-sent. `email`/`sms` describe an INTENDED
// governed channel; an actual send is the GATED 4.3 path (governOutboundSend) —
// 4.1 NEVER sends, so a grant created here stays at `last_delivered_at = NULL`
// regardless of this value.
export const ExternalShareDeliveryChannelSchema = z.enum(['email', 'sms', 'manual_link']);
export type ExternalShareDeliveryChannel = z.infer<typeof ExternalShareDeliveryChannelSchema>;

export const ExternalSharePermissionsSchema = z
  .object({
    overview: z.object({ on: z.boolean() }).strict(),
    documents: z
      .object({
        on: z.boolean(),
        actions: z.object({ download: z.boolean() }).strict(),
      })
      .strict(),
    signatures: z.object({ on: z.boolean() }).strict(),
  })
  .strict()
  // Fail-closed coherence: a download capability with the documents resource
  // OFF is a contradictory (and latently over-permissive) grant — the download
  // flag is precisely the sensitive-byte vector that the X-S4 read enforcer will
  // consume. Reject `download && !on` here so no such row is ever persisted.
  .refine((p) => !p.documents.actions.download || p.documents.on, {
    message: 'documents.actions.download requires documents.on',
    path: ['documents', 'actions', 'download'],
  });
export type ExternalSharePermissions = z.infer<typeof ExternalSharePermissionsSchema>;

export const ExternalShareSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  partyType: ExternalSharePartyTypeSchema,
  scopeType: ExternalShareScopeTypeSchema,
  scopeIds: z.array(z.string().uuid()),
  permissions: ExternalSharePermissionsSchema,
  allowSensitive: z.boolean(),
  otpRequired: z.boolean(),
  expiresAt: z.coerce.date().nullable(),
  watermarkSubject: z.string().nullable(),
  // W-4.1 recipient capture. `recipientName` is a free-text CONTACT LABEL
  // (not legally PII — e.g. "עו״ד כהן"). `recipientEmailMasked` /
  // `recipientPhoneMasked` are MASKED projections of the pgcrypto-encrypted
  // columns — the raw value NEVER crosses this wire (no plaintext, no
  // ciphertext). NULL when not captured / not maskable.
  recipientName: z.string().nullable(),
  recipientEmailMasked: z.string().nullable(),
  recipientPhoneMasked: z.string().nullable(),
  deliveryChannel: ExternalShareDeliveryChannelSchema,
  // Set ONLY by a real governed send (4.3). NULL here ⇒ "טרם נשלח" (per the
  // #549 honesty fix); 4.1 never sends, so it stays NULL on every 4.1 row.
  lastDeliveredAt: z.coerce.date().nullable(),
  revokedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ExternalShareView = z.infer<typeof ExternalShareSchema>;

// W-4.1 — recipient-capture INPUT fragment (raw values IN; the server encrypts
// email/phone via pgcrypto before persistence and NEVER echoes them back —
// reads return only the masked projection). `recipientName` is a contact label
// (≤200), not legally PII. `deliveryChannel` intent (the actual send is the
// gated 4.3 path). All optional/additive — every existing caller stays valid.
const RecipientInputShape = {
  recipientName: z.string().trim().min(1).max(200).nullable().optional(),
  recipientEmail: z.string().trim().email().max(320).nullable().optional(),
  recipientPhone: z.string().trim().min(3).max(40).nullable().optional(),
  deliveryChannel: ExternalShareDeliveryChannelSchema.optional(),
} as const;

/** POST body — create an external-share grant. The server re-validates the
 *  requested scope_type + permissions + allow_sensitive against the party's
 *  preset CEILING (fail-closed, narrows-only). `scopeIds` is non-empty. */
export const CreateExternalShareInput = z
  .object({
    partyType: ExternalSharePartyTypeSchema,
    scopeType: ExternalShareScopeTypeSchema,
    scopeIds: z.array(z.string().uuid()).min(1).max(500),
    permissions: ExternalSharePermissionsSchema,
    allowSensitive: z.boolean().default(false),
    // OTP default-ON (org/council decision). A per-share narrow may turn it
    // off (X-S4 enforces the org default-ON ceiling).
    otpRequired: z.boolean().default(true),
    // ISO datetime; the server caps it at the party ceiling's maxTtlDays.
    expiresAt: z.coerce.date().nullable().optional(),
    watermarkSubject: z.string().max(200).optional(),
    ...RecipientInputShape,
  })
  .strict();
export type CreateExternalShare = z.infer<typeof CreateExternalShareInput>;

/** PATCH body — update an active grant. NARROWS-ONLY: every field is optional;
 *  the service rejects any change that widens beyond the party ceiling OR
 *  beyond the grant's current footprint. */
export const UpdateExternalShareInput = z
  .object({
    scopeType: ExternalShareScopeTypeSchema.optional(),
    scopeIds: z.array(z.string().uuid()).min(1).max(500).optional(),
    permissions: ExternalSharePermissionsSchema.optional(),
    allowSensitive: z.boolean().optional(),
    otpRequired: z.boolean().optional(),
    watermarkSubject: z.string().max(200).nullable().optional(),
    ...RecipientInputShape,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateExternalShare = z.infer<typeof UpdateExternalShareInput>;

/** PATCH body — extend the TTL (push expires_at forward). The server caps the
 *  new value at the party ceiling's maxTtlDays from now and refuses to move it
 *  backward. */
export const ExtendExternalShareInput = z.object({ expiresAt: z.coerce.date() }).strict();
export type ExtendExternalShare = z.infer<typeof ExtendExternalShareInput>;

export const ListExternalSharesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
  partyType: ExternalSharePartyTypeSchema.optional(),
});
export type ListExternalSharesQueryDto = z.infer<typeof ListExternalSharesQuery>;

// SEC-H1 — the party-share document-retrieval AUTHZ DECISION contract.
//
// The shared `ExternalPartyAuthzResolver` consumes `external_shares`
// (expiry / revocation / scope / allow_sensitive / OTP / watermark) and yields
// this allow/deny verdict + serve constraints. The manager-facing resolution
// endpoint (`GET /external-shares/:id/documents/:documentId/access`) returns it
// so the "invite a party" FE (UX-slice-4) can show what a party WOULD reach
// before the X-S4 party-token tier lands. Deny reasons are coarse + PII-free.

export const ExternalPartyDenyReasonSchema = z.enum([
  'share_revoked',
  'share_expired',
  'documents_not_granted',
  'download_not_granted',
  'out_of_scope',
  'sensitive_not_allowed',
  'otp_required',
  'document_not_servable',
]);
export type ExternalPartyDenyReason = z.infer<typeof ExternalPartyDenyReasonSchema>;

export const ExternalPartyServeConstraintsSchema = z
  .object({
    requiresDecryptStream: z.boolean(),
    watermarkSubject: z.string().nullable(),
  })
  .strict();
export type ExternalPartyServeConstraints = z.infer<typeof ExternalPartyServeConstraintsSchema>;

export const ExternalPartyAccessDecisionSchema = z.discriminatedUnion('allow', [
  z.object({ allow: z.literal(true), constraints: ExternalPartyServeConstraintsSchema }).strict(),
  z.object({ allow: z.literal(false), reason: ExternalPartyDenyReasonSchema }).strict(),
]);
export type ExternalPartyAccessDecision = z.infer<typeof ExternalPartyAccessDecisionSchema>;

/** Query for the resolution endpoint: whether to evaluate as OTP-verified (the
 *  X-S4 party-token tier will set this from a real verified session; the
 *  manager preview defaults to false = fail-closed).
 *
 *  Explicit 'true'|'false' enum — NOT z.coerce.boolean (which coerces the
 *  *string* 'false' to `true`, a fail-OPEN that would let `?otpVerified=false`
 *  clear the OTP gate). A missing or 'false' value yields `false` (fail-closed);
 *  ONLY the literal string 'true' yields `true`. Inferred type is boolean. */
export const ExternalPartyAccessQuery = z
  .object({
    otpVerified: z
      .enum(['true', 'false'])
      .optional()
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict();
export type ExternalPartyAccessQueryDto = z.infer<typeof ExternalPartyAccessQuery>;

// ════════════════════════════════════════════════════════════════════════════
// W-4.1 — the DocumentParty → ExternalSharePartyType BRIDGE (THE one new
// canonical artifact of this slice) + the `party_request` (who-owes-what)
// contract.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The ONE-DIRECTIONAL, PARTIAL, FAIL-CLOSED bridge from the binder
 * `DocumentParty` axis ("who is responsible for this document") to the
 * external-share `ExternalSharePartyType` taxonomy ("what KIND of external
 * counterparty gets a grant"). The two enums are deliberately NON-ISOMORPHIC:
 * the binder asks WHO, the share asks WHAT-COUNTERPARTY.
 *
 * Mapping (the ONLY auto-mintable correspondences):
 *   - appraiser   → appraiser
 *   - surveyor    → surveyor
 *   - supervisor  → supervisor
 *   - lawyer      → tenant_lawyer   (the resident-side lawyer is the binder's עו״ד)
 *   - contractor  → developer       (the קבלן/יזם is the deal's principal developer)
 *
 * EVERYTHING ELSE → `null` (FAIL-CLOSED):
 *   - municipality / architect / owner / other
 *
 * A `party_request` MAY be created for a `null`-bridge party purely to TRACK an
 * obligation (who-owes-what), but its `delivery_channel` can ONLY be
 * `manual_link` and NO external-share grant is ever auto-minted for it — the
 * 4.2/4.3 send paths MUST hard-reject auto-mint where this returns `null`.
 * There is no "default" arm: every key is listed explicitly so adding a new
 * `DocumentParty` is a COMPILE error here (the exhaustiveness spec re-asserts
 * it at test time) — you cannot silently fall into an auto-mint.
 */
export const partyTypeForDocumentParty: Record<DocumentParty, ExternalSharePartyType | null> = {
  owner: null,
  appraiser: 'appraiser',
  architect: null,
  municipality: null,
  contractor: 'developer',
  lawyer: 'tenant_lawyer',
  supervisor: 'supervisor',
  surveyor: 'surveyor',
  other: null,
};

/** Pure helper — resolves the auto-mintable share party type for a binder
 *  party, or `null` when the party is track-only (fail-closed). The single
 *  read point so callers never re-derive the map. */
export function shareePartyTypeFor(party: DocumentParty): ExternalSharePartyType | null {
  return partyTypeForDocumentParty[party];
}

/** True iff a grant MAY be auto-minted for this binder party (bridge is
 *  non-null). When false, only a `manual_link` track-request is permitted. */
export function canAutoMintGrantFor(party: DocumentParty): boolean {
  return partyTypeForDocumentParty[party] !== null;
}

/** The 9 canonical binder parties, re-exported as the `party_request` party
 *  domain (one shared tuple with the binder — never a second list). */
export const PartyRequestPartyEnum = z.enum(DOCUMENT_PARTY_VALUES);
export type PartyRequestParty = z.infer<typeof PartyRequestPartyEnum>;

/** `party_request.status` — the obligation lifecycle. `open` (created, nothing
 *  sent) → `delivered` (a real governed send happened, 4.3) → `fulfilled` (the
 *  awaited document arrived) ; `cancelled` is the only termination (NO physical
 *  delete — DELETE is REVOKED on the table; cancel is a status transition). */
export const PartyRequestStatusSchema = z.enum(['open', 'delivered', 'fulfilled', 'cancelled']);
export type PartyRequestStatus = z.infer<typeof PartyRequestStatusSchema>;

/** A who-owes-what obligation row (read projection). PII-free: it names a
 *  PROJECT + a binder PARTY + a requested doc type, never a person. */
export const PartyRequestSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  projectId: z.string().uuid(),
  documentParty: PartyRequestPartyEnum,
  requestedDocType: z.string().nullable(),
  status: PartyRequestStatusSchema,
  externalShareId: z.string().uuid().nullable(),
  fulfilledDocumentId: z.string().uuid().nullable(),
  fulfilledAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PartyRequestView = z.infer<typeof PartyRequestSchema>;

/** POST body — create a who-owes-what obligation. The server enforces the
 *  partial-unique (one live obligation per project/party/doc-type), the
 *  `isOrgSuspended` gate, and the bridge constraint (a `null`-bridge party may
 *  be tracked but never auto-minted). `requestedDocType` is tolerant text. */
export const CreatePartyRequestInput = z
  .object({
    projectId: z.string().uuid(),
    documentParty: PartyRequestPartyEnum,
    requestedDocType: z.string().trim().min(1).max(120).nullable().optional(),
    externalShareId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type CreatePartyRequest = z.infer<typeof CreatePartyRequestInput>;

/** List query — the who-owes-what board feed. Keyset-paginated; optional
 *  project / party / status narrows (NARROWING only). */
export const ListPartyRequestsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).optional(),
    projectId: z.string().uuid().optional(),
    documentParty: PartyRequestPartyEnum.optional(),
    status: PartyRequestStatusSchema.optional(),
  })
  .strict();
export type ListPartyRequestsQueryDto = z.infer<typeof ListPartyRequestsQuery>;
