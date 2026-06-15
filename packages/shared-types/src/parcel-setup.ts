import { z } from 'zod';

// P3a — parcel_setups contract (Doc 11 SoT; docs/DESIGN-phase3-parcel-autosetup.md
// §1/§4/§6 P3a/§7.1). A `parcel_setup` is the PROJECT-attached envelope around a
// single גוש-חלקה setup run: the user enters block+parcel(+sub), drafts the
// proposed buildings/apartments as a jsonb payload (the MANUAL path this slice;
// the IParcelDataProvider seam is P3b), and CONFIRM materializes the physical
// skeleton (buildings + apartments) with provenance. The payload holds NO PII —
// strict schemas at EVERY level are the defense (no ownerName/nationalId/phone
// key can ever land in the public-record jsonb column).

// Closed lifecycle enum. Authoritative API-edge enforcement (mirrors the DB
// CHECK on parcel_setups.status, migration 0073).
export const ParcelSetupStatusSchema = z.enum(['draft', 'confirmed', 'discarded']);
export type ParcelSetupStatus = z.infer<typeof ParcelSetupStatusSchema>;

/**
 * The STRICT draft-payload schema (PATCH /parcel-setups/:id body.payload).
 * Buildings + their estimated apartments as the user drafted them. `.strict()`
 * at EVERY level is the no-PII defense: any unknown key (ownerName, nationalId,
 * phone, …) is rejected — the payload column is a public-record jsonb (no
 * pgcrypto), so PII must be structurally impossible, not just discouraged.
 * `floorsCount`/`number` are DRAFT-ONLY hints (no building columns — confirm
 * does not map them).
 */
export const ParcelSetupPayload = z
  .object({
    buildings: z
      .array(
        z
          .object({
            address: z.string().min(1).max(300),
            city: z.string().min(1).max(120).optional(),
            number: z.string().min(1).max(20).optional(),
            floorsCount: z.number().int().min(0).max(200).optional(),
            apartments: z
              .array(
                z
                  .object({
                    number: z.string().min(1).max(20),
                    floor: z.number().int().min(-10).max(200).optional(),
                  })
                  .strict(),
              )
              .max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type ParcelSetupPayloadDto = z.infer<typeof ParcelSetupPayload>;

/** Canonical wire shape returned by the API ({ data } envelope). */
export const ParcelSetupSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  blockNumber: z.string(),
  parcelNumber: z.string(),
  subParcel: z.string().nullable(),
  status: ParcelSetupStatusSchema,
  // 'manual', or the provider's providerId ('local-mapi') when the P3b lookup
  // found the parcel — stamped server-side from the provider result ONLY
  // (never from the DTO; it is the review flag).
  source: z.string(),
  // P3b — the create-time provider lookup outcome: 'found' | 'not_found'
  // (NULL only on pre-P3b rows). providerCity is stamped when found.
  providerStatus: z.string().nullable(),
  providerCity: z.string().nullable(),
  payload: ParcelSetupPayload.nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.coerce.date(),
  // NULL on a fresh draft; stamped when the draft is confirmed.
  confirmedAt: z.coerce.date().nullable(),
});
export type ParcelSetup = z.infer<typeof ParcelSetupSchema>;

/**
 * Create a parcel-setup envelope on an EXISTING project (§7.1-4) —
 * POST /projects/:projectId/parcel-setups. Block/parcel are PUBLIC land-
 * registration numbers (not PII). Strict: no extra keys.
 */
export const CreateParcelSetupInput = z
  .object({
    blockNumber: z.string().min(1).max(20),
    parcelNumber: z.string().min(1).max(20),
    subParcel: z.string().min(1).max(20).optional(),
  })
  .strict();
export type CreateParcelSetup = z.infer<typeof CreateParcelSetupInput>;

/**
 * PATCH /parcel-setups/:id body — save the draft buildings/apartments JSON.
 * DRAFT-only (409 parcel_setup_not_draft otherwise). The service RE-parses
 * the payload with ParcelSetupPayload (defense-in-depth).
 */
export const UpdateParcelSetupPayloadInput = z
  .object({
    payload: ParcelSetupPayload,
  })
  .strict();
export type UpdateParcelSetupPayload = z.infer<typeof UpdateParcelSetupPayloadInput>;
