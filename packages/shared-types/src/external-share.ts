import { z } from 'zod';

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
  revokedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ExternalShareView = z.infer<typeof ExternalShareSchema>;

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
