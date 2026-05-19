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

/** Owner resource as returned by the API — PII is masked, never clear. */
export const OwnerSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string().min(1).max(100),
  email: z.string().email().nullable(),
  /** e.g. "•••••••82" — 7 bullets + last 2 digits. */
  nationalIdMasked: z.string(),
  /** e.g. "••••• 1234" suffix, or null when no phone on file. */
  phoneMasked: z.string().nullable(),
  notes: z.string().max(2000).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type Owner = z.infer<typeof OwnerSchema>;

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

/** POST body — name + national_id required. */
export const CreateOwnerInput = z.object(ownerWriteShape).strict();
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
});
export type ListOwnersQueryDto = z.infer<typeof ListOwnersQuery>;
