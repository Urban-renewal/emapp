import { z } from 'zod';

// Canonical Owner contract (Doc 11 SoT; Phase 3 Slice 4).
//
// PII RULES (CLAUDE.md / Doc07): national_id + phone are pgcrypto-encrypted
// at rest and NEVER returned in clear by the API. Responses carry only a
// MASKED form (last digits). Field name is `national_id` (D.19 — never tz).
// Owners are ORG-scoped (owners.org_id → direct RLS, not via-parent).
// `ownership_pct` (Doc09 §3.13 Owner) is NOT here — it is a property of an
// ownership (apartment ↔ owner), delivered by Slice 5; recorded as
// deliberate (no Gate-2 deviation, PROGRESS doc-debt).
//
// This file is PURE Zod (no @emapp/* imports). The Israeli-ID checksum and
// phone normalization are layered in the BE DTO (apps/api) via
// @emapp/validators — kept out of here to preserve shared-types purity;
// the FE composes the same validators on top.

/**
 * Mask alphabet — bullet, asterisk, hyphen, digit, space. AND must
 * contain at least one mask character (bullet or asterisk). Closes
 * §v9-M-4: a future server bug that returned the CLEAR 9-digit
 * value would have passed the old `z.string()` permissive schema;
 * with this regex, the FE rejects it at parse time and surfaces an
 * invalid_response error instead of rendering cleartext PII.
 */
const MaskedPii = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[•*\-\s\d]+$/, 'must use only mask characters [•*\\-\\s\\d]')
  .regex(/[•*]/, 'must contain at least one mask character (bullet or asterisk)');

/**
 * Owner resource as returned by the API — PII is ALWAYS masked, for every role
 * (D.54 reveal-on-demand model: list/detail/search/export never carry cleartext;
 * the §v9-M-4 tripwire holds on every list/detail surface). Cleartext is obtained
 * only via the dedicated, audited reveal endpoint (`OwnerPiiRevealSchema`).
 */
export const OwnerSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  /** S3a — null for an owner SHELL (skeleton with no name yet); the FE
   *  renders a placeholder. Otherwise a 1–100 char name. */
  name: z.string().min(1).max(100).nullable(),
  email: z.string().email().nullable(),
  /** e.g. "•••••••82" — 7 bullets + last 2 digits. S3a — null for a SHELL
   *  with no national_id yet. */
  nationalIdMasked: MaskedPii.nullable(),
  /** e.g. "•••••1234" suffix, or null when no phone on file. */
  phoneMasked: MaskedPii.nullable(),
  notes: z.string().max(2000).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type Owner = z.infer<typeof OwnerSchema>;

/**
 * Owner as returned by the LIST endpoint (GET /owners) — the masked Owner plus
 * two management-context aggregates so the list is an actionable table, not a
 * bare name-list. Both are non-negative integers and carry NO PII (counts only).
 *
 * `apartmentCount` — the owner's ACTIVE ownerships (apartments they currently
 * own). `pendingSignatureCount` — their signature_requests in status 'pending'.
 * For an AGENT both counts are scoped to assigned projects (the BE mirrors the
 * agent owner-scope), so a count never leaks a project the agent can't see.
 *
 * Additive over OwnerSchema: get/reveal/search keep returning plain Owner.
 */
export const OwnerListItemSchema = OwnerSchema.extend({
  apartmentCount: z.number().int().nonnegative(),
  pendingSignatureCount: z.number().int().nonnegative(),
});
export type OwnerListItem = z.infer<typeof OwnerListItemSchema>;

/**
 * D.54 — reveal-on-demand response (POST /owners/:id/reveal-pii). A SEPARATE
 * schema from `OwnerSchema` (which is masked-only and tripwire-protected): this
 * one deliberately carries the CLEARTEXT national_id/phone of a single owner,
 * returned ONLY to an actor with `view_owner_pii` (manager always · agent per
 * flag · viewer never) for an owner in their scope, and the access is audited.
 * It is NOT a list/detail shape and must never be substituted for `OwnerSchema`.
 */
export const OwnerPiiRevealSchema = z.object({
  id: z.string().uuid(),
  /** CLEARTEXT national_id — exactly 9 digits (D.19). S3a — null for an
   *  owner SHELL with no national_id yet. */
  nationalId: z
    .string()
    .regex(/^\d{9}$/)
    .nullable(),
  /** CLEARTEXT phone, or null when none on file. */
  phone: z.string().min(1).max(20).nullable(),
});
export type OwnerPiiReveal = z.infer<typeof OwnerPiiRevealSchema>;

// Write shape. national_id is structurally 9 digits here; the MOD-10
// checksum is enforced in the BE DTO refine (validator-backed). phone is
// optional; BE normalizes to E.164 and rejects non-Israeli numbers.
// `.strict()` fail-closed (FE-security DoD).
const ownerWriteShape = {
  name: z.string().min(1).max(100),
  national_id: z.string().regex(/^\d{9}$/, 'national_id must be exactly 9 digits'),
  phone: z.string().min(9).max(20).nullable().optional(),
  email: z.string().email().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
} as const;

/**
 * POST body. S3a — owner SHELLS: `name` and `national_id` are OPTIONAL so a
 * skeleton owner (Tabu/parcel import; a field worker enriches later) can be
 * created with neither. When PRESENT they keep the same structural validation
 * (name length, national_id 9-digit + BE-DTO checksum). All other fields keep
 * their prior optionality. `.strict()` fail-closed (FE-security DoD).
 */
export const CreateOwnerInput = z
  .object({
    ...ownerWriteShape,
    name: ownerWriteShape.name.optional(),
    national_id: ownerWriteShape.national_id.optional(),
  })
  .strict();
export type CreateOwner = z.infer<typeof CreateOwnerInput>;

/** PATCH body — every field optional (national_id re-validated if present). */
export const UpdateOwnerInput = z.object(ownerWriteShape).partial().strict();
export type UpdateOwner = z.infer<typeof UpdateOwnerInput>;

/**
 * Owner lookup by HMAC of a PII value (T3.O.1 round-trip). Sent in the
 * REQUEST BODY (never the URL/query) so the value cannot leak into access
 * logs; the server HMACs it and matches the stored hash — the clear value
 * is never persisted to logs.
 */
export const OwnerSearchInput = z
  .object({
    national_id: z
      .string()
      .regex(/^\d{9}$/)
      .optional(),
    phone: z.string().min(9).max(20).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.national_id) || Boolean(v.phone), {
    message: 'provide national_id or phone',
  });
export type OwnerSearch = z.infer<typeof OwnerSearchInput>;

/** GET list query — cursor pagination only (D.16; never offset). */
export const ListOwnersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
  /**
   * `'true'` returns the ARCHIVED owners (the default view filters them out, so
   * archived records would otherwise be invisible in the cockpit). Explicit
   * 'true'|'false' enum — NOT z.coerce.boolean, which coerces the *string*
   * 'false' to `true`. Inferred type is boolean.
   */
  archived: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
});
export type ListOwnersQueryDto = z.infer<typeof ListOwnersQuery>;

/**
 * NS1 (server-side search, MASTER-PLAN-V13 Wave B) — owner NAME search query
 * for GET /owners/search. This is DISTINCT from `OwnerSearchInput` (the POST
 * by-PII HMAC lookup): this is a substring search over the owner NAME, keyset-
 * paginated, returning the SAME masked-PII projection as the list endpoint
 * (never national_id/phone cleartext). `q` is required (an empty search has no
 * meaning here); it is trimmed + bounded. Cursor pagination only (D.16).
 *
 * SECURITY: the owner name is PII stored ENCRYPTED at rest; the BE decrypts it
 * IN-SQL under the withTenant key and ILIKEs the plaintext — the clear name
 * never crosses the wire except inside the masked owner projection's `name`
 * field (which list/get already return). national_id/phone stay masked.
 */
export const OwnerNameSearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type OwnerNameSearchQueryDto = z.infer<typeof OwnerNameSearchQuery>;
