import { z } from 'zod';

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

/** State machine. `pending` = link out, awaiting resident. */
export const SignatureRequestStatusEnum = z.enum(['pending', 'signed', 'cancelled']);
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
  deepLink: z.string().url().optional(),
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
  signUrl: z.string().url(),
  delivery: SignatureDeliveryReportSchema,
});
export type SignatureRequestCreateResponse = z.infer<typeof SignatureRequestCreateResponseSchema>;

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
    downloadUrl: z.string().url(),
  }),
  owner: z.object({
    name: z.string(),
  }),
  expiresAt: z.coerce.date(),
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
