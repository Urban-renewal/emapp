import { z } from 'zod';

import { HttpsUrlSchema, WhatsAppDeepLinkSchema } from './safe-url';

// Canonical SignatureRequest contract — Phase 5 (docs/03 §9, D.12 LAW).
//
// Locked-schema alignment: the `signature_requests` table (migration 0021)
// has columns id, org_id, document_id, owner_id, jti, status, expires_at,
// created_by, created_at, signed_at, signed_signature_id, cancelled_at,
// cancelled_by. The signing payload (SVG) lives in the separate
// `signatures` table — D.12 LAW (svg, encrypted, inline).
//
// SECURITY:
//  - `jti` is the JWT id and the atomic single-use guard's key. NEVER on
//    the wire — clients receive only the signed JWT itself.
//  - The token (JWT) is server-minted at create time and only returned
//    embedded in `signUrl`. Never accepted as input from clients.
//  - `signature_requests.signed_signature_id` is internal — exposed as
//    `signedSignatureId` only on signed/cancelled views.

/** State machine. `pending` = link out, awaiting resident; `expired` = a
 *  pending link whose 7-day deadline lapsed before it was signed (terminal —
 *  the manager re-issues a fresh request). Mirrors the DB CHECK widened in
 *  migration 0063 (CHECK == wire-enum invariant). */
export const SignatureRequestStatusEnum = z.enum(['pending', 'signed', 'cancelled', 'expired']);
export type SignatureRequestStatus = z.infer<typeof SignatureRequestStatusEnum>;

/** Wire shape — manager-side view. Never exposes `jti` (token-id) or
 * the raw JWT. Cancelled/signed requests still surface (forensic). */
export const SignatureRequestSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  documentId: z.string().uuid(),
  ownerId: z.string().uuid(),
  status: SignatureRequestStatusEnum,
  expiresAt: z.coerce.date(),
  createdBy: z.string().uuid(),
  createdAt: z.coerce.date(),
  signedAt: z.coerce.date().nullable(),
  signedSignatureId: z.string().uuid().nullable(),
  cancelledAt: z.coerce.date().nullable(),
  cancelledBy: z.string().uuid().nullable(),
});
export type SignatureRequest = z.infer<typeof SignatureRequestSchema>;

/** POST /signature-requests body. The Manager picks the (document, owner)
 * pair; the server validates both are visible in the manager's org and
 * mints the token. Delivery channels are server-defaulted (Email always,
 * WhatsApp deep-link when phone exists). */
export const CreateSignatureRequestInput = z
  .object({
    documentId: z.string().uuid(),
    ownerId: z.string().uuid(),
  })
  .strict();
export type CreateSignatureRequest = z.infer<typeof CreateSignatureRequestInput>;

/** Per-channel delivery result. `available=false` is honest — it tells
 * the FE/Manager that a channel was skipped (e.g. no email on file, or
 * SMS provider not configured in MVP). `error` is generic; no PII / no
 * provider-internal codes leaked. */
export const SignatureDeliveryChannelResultSchema = z.object({
  available: z.boolean(),
  /** Set only when `available` is true. For email/sms it's `'sent'` or
   *  `'queued'`; for whatsapp deep-link it's `'ready'` (link returned). */
  status: z.enum(['sent', 'queued', 'ready', 'rejected']).optional(),
  /** Email recipient masked (`name@domain` → `na***@domain`) /
   *  whatsapp deep-link URL. Never raw E.164 phone in this field. */
  to: z.string().optional(),
  /** Whatsapp deep-link `wa.me/<phone>?text=...` — present ONLY for the
   *  whatsapp channel. Manager taps to send via their own WhatsApp. */
  // §RED-1 — scheme allowlist: deep link goes to https://wa.me/... only.
  deepLink: WhatsAppDeepLinkSchema.optional(),
  /** Generic reason for unavailability (e.g. `'no_email_on_file'`,
   *  `'sms_provider_not_configured'`). NEVER a provider-internal code. */
  reason: z.string().optional(),
});
export type SignatureDeliveryChannelResult = z.infer<typeof SignatureDeliveryChannelResultSchema>;

export const SignatureDeliveryReportSchema = z.object({
  email: SignatureDeliveryChannelResultSchema,
  whatsapp: SignatureDeliveryChannelResultSchema,
  sms: SignatureDeliveryChannelResultSchema,
});
export type SignatureDeliveryReport = z.infer<typeof SignatureDeliveryReportSchema>;

/** POST /signature-requests response. `signUrl` contains the JWT and is
 * a bearer credential — short TTL (7d), single-use, never logged. */
export const SignatureRequestCreateResponseSchema = z.object({
  request: SignatureRequestSchema,
  // §RED-1 — bearer credential URL; pin to https.
  signUrl: HttpsUrlSchema,
  delivery: SignatureDeliveryReportSchema,
});
export type SignatureRequestCreateResponse = z.infer<typeof SignatureRequestCreateResponseSchema>;

/** GET /signature-requests/:id/link response — the manager retrieves the
 *  signing link for a PENDING request their org owns, to deliver it OUT-OF-BAND
 *  (WhatsApp / email / paper). This is the phone-less-owner path: an owner with
 *  no phone can't be SMS'd the link and can't self-serve the SMS-OTP portal, so
 *  the manager copies this link and delivers it manually.
 *
 *  SECURITY: `signUrl` embeds the JWT and is a BEARER credential — short TTL
 *  (7d), single-use, never logged. Returning it here does NOT widen exposure
 *  beyond what the manager could already obtain: the same manager can trigger a
 *  resend (which SMS/emails this very link). Authorization MUST match the send
 *  path (`signature_requests.send` + manage_signatures capability) so a
 *  read-only Viewer / unprivileged Agent cannot read it. Calling this re-mints
 *  a fresh token + 7-day expiry (the prior link dies) so the DB row's `jti` is
 *  always the single source of truth for the live link. */
export const SignatureRequestLinkResponseSchema = z.object({
  request: SignatureRequestSchema,
  // §RED-1 — bearer credential URL; pin to https.
  signUrl: HttpsUrlSchema,
});
export type SignatureRequestLinkResponse = z.infer<typeof SignatureRequestLinkResponseSchema>;

/** POST /signature-requests/bulk body — send ONE document to MANY owners in a
 * single action (the manager's most-repeated task: a whole building's owners).
 * The server SKIPS owners that already have a pending request for this document
 * (no throw) so a partial-overlap bulk still sends to the rest. Capped to bound
 * the per-request fan-out; the FE resolves "all owners in building/project" to
 * the id list. */
export const BulkCreateSignatureRequestInput = z
  .object({
    documentId: z.string().uuid(),
    ownerIds: z.array(z.string().uuid()).min(1).max(200),
  })
  .strict();
export type BulkCreateSignatureRequest = z.infer<typeof BulkCreateSignatureRequestInput>;

/** POST /projects/:id/signature-campaign body — fan out ONE document to ALL
 * ACTIVE owners across the project's apartments in a single action (S5b). The
 * server DERIVES the recipient owner list (owner → active ownership → apartment
 * → building → project = :id), so — unlike the bulk endpoint — the client does
 * NOT supply ownerIds; it only picks the project-scoped document. The reuse of
 * the bulk path means the #2 association gate + #3 expired-dedup + delivery all
 * apply. `expiresInDays` is reserved for a future per-campaign deadline override
 * (the underlying token TTL default applies when omitted). */
export const SignatureCampaignInput = z
  .object({
    documentId: z.string().uuid(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();
export type SignatureCampaignInput = z.infer<typeof SignatureCampaignInput>;

/** POST /projects/:id/signature-campaign response — the rolled-up fan-out
 * tallies. `total` is the count of DISTINCT active owners derived for the
 * project; `created` is how many got a fresh pending request; `skipped` is how
 * many already had a LIVE pending request (the #3 dedup). created+skipped may be
 * < total when a derived owner fails the #2 association gate (should not happen
 * for project-derived owners, but kept honest). */
export const SignatureCampaignResponseSchema = z.object({
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type SignatureCampaignResponse = z.infer<typeof SignatureCampaignResponseSchema>;

/** POST /projects/:id/signature-requests/remind response (HB-1) — the rolled-up
 * "chase the stuck pending signers" tally. The server DERIVES every LIVE PENDING
 * signature request of the project (status='pending' AND expires_at > now(),
 * joined ownership → apartment → building → project = :id), re-mints a fresh
 * token + 7-day expiry for each, and re-delivers it (REUSING the per-request
 * resend path). The client supplies NO ownerIds and NO documentId.
 *
 * `total` = count of live-pending requests derived for the project; `reminded` =
 * how many were successfully re-minted + re-delivered. reminded may be < total
 * if a per-request delivery fails (the rest still process; the tally stays
 * honest). Unlike a campaign this NEVER touches already-signed owners — it only
 * re-chases the ones still pending. */
export const RemindPendingResponseSchema = z.object({
  reminded: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type RemindPendingResponse = z.infer<typeof RemindPendingResponseSchema>;

/** Per-owner outcome of a bulk send. `created` = a new pending request + a
 * delivery attempt; `skipped_existing` = that owner already had a pending
 * request for this document; `failed` = owner not visible/in-org or an
 * unexpected per-owner error (the rest still process). The token is NOT a
 * first-class response field (no `signUrl`/`token` key); it appears only
 * URL-encoded inside the manager's WhatsApp `deepLink` in the delivery report —
 * exactly as single-create's `signUrl` does — so the manager can tap-send. */
export const BulkSignatureResultSchema = z.object({
  ownerId: z.string().uuid(),
  outcome: z.enum(['created', 'skipped_existing', 'failed']),
  requestId: z.string().uuid().optional(),
  delivery: SignatureDeliveryReportSchema.optional(),
  reason: z.string().optional(),
});
export type BulkSignatureResult = z.infer<typeof BulkSignatureResultSchema>;

export const BulkSignatureRequestResponseSchema = z.object({
  results: z.array(BulkSignatureResultSchema),
  summary: z.object({
    created: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});
export type BulkSignatureRequestResponse = z.infer<typeof BulkSignatureRequestResponseSchema>;

/** GET /signature-requests — keyset pagination + optional status filter. */
export const ListSignatureRequestsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).optional(),
    status: SignatureRequestStatusEnum.optional(),
    documentId: z.string().uuid().optional(),
    ownerId: z.string().uuid().optional(),
  })
  .strict();
export type ListSignatureRequestsQueryDto = z.infer<typeof ListSignatureRequestsQuery>;

// ── Public sign endpoint (no auth; the JWT is the credential) ──────────

/** GET /sign/:token response — minimal preview info so the resident can
 *  see what they're signing. Document URL is a short-lived presigned GET,
 *  minted only on this read. No org-level data leaked. */
export const PublicSignPreviewSchema = z.object({
  document: z.object({
    name: z.string(),
    // §RED-1 — public sign page renders this in <a href>; pin to https.
    downloadUrl: HttpsUrlSchema,
  }),
  owner: z.object({
    name: z.string(),
  }),
  expiresAt: z.coerce.date(),
  /** P0.C2 — the org's configurable PII-processing privacy notice the resident
   *  must see before signing. `text` is the exact wording shown (resolved from
   *  OrgSettings.privacy.noticeText); `version` is pinned into the consent
   *  record. `requireExplicitConsent` tells the FE whether to gate the Submit
   *  button on an explicit checkbox (true) or show an implicit-by-signing
   *  acknowledgment line (false). */
  consentNotice: z.object({
    text: z.string(),
    version: z.string(),
    requireExplicitConsent: z.boolean(),
  }),
});
export type PublicSignPreview = z.infer<typeof PublicSignPreviewSchema>;

/** POST /sign/:token body. `signatureSvg` is the SVG markup from the
 *  Canvas — bounded to prevent payload-bombing; D.12 mandates SVG. */
export const PUBLIC_SIGN_SVG_MAX_BYTES = 262_144; // 256 KB — generous for a Canvas signature
export const PublicSignSubmitInput = z
  .object({
    signatureSvg: z
      .string()
      .min(50, 'signature_too_short')
      .max(PUBLIC_SIGN_SVG_MAX_BYTES, 'signature_too_large')
      .regex(/^<svg[\s\S]*<\/svg>$/i, 'not_svg'),
    /** P0.C2 — the resident's explicit acknowledgment of the PII-processing
     *  notice. Optional on the wire: when the org sets
     *  `privacy.requireExplicitConsent`, the BE enforces this must be `true`
     *  (else `consent_required`). When false/absent the consent is recorded
     *  implicitly-by-signing. The consent RECORD is written either way. */
    acknowledgeConsent: z.boolean().optional(),
  })
  .strict();
export type PublicSignSubmit = z.infer<typeof PublicSignSubmitInput>;

/** POST /sign/:token response — confirmation only. The signature itself
 *  is forensic evidence in the `signatures` table; the public response
 *  carries minimum surface (no signatureId, no internal state). */
export const PublicSignSubmitResponseSchema = z.object({
  signedAt: z.coerce.date(),
});
export type PublicSignSubmitResponse = z.infer<typeof PublicSignSubmitResponseSchema>;
