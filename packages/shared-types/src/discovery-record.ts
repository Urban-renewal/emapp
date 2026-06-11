import { z } from 'zod';

// S3c — discovery_records contract (Doc 11 SoT). "renter → discovery-source"
// (DESIGN-project-model-and-autosetup.md §2 + §6): an occupant is NOT an
// owner/signer — it is a DISCOVERY SOURCE attached to an APARTMENT (a field
// worker spoke to whoever lives there to learn who the owner is). This replaces
// the retired ownerships.relationship='renter' overload (migration 0066).

// Closed discovery-status enum (§6). Authoritative API-edge enforcement
// (mirrors the DB CHECK on discovery_records.status).
export const DiscoveryStatusSchema = z.enum([
  'not_visited',
  'no_answer',
  'spoke_to_occupant',
  'owner_identified',
  'refused',
]);
export type DiscoveryStatus = z.infer<typeof DiscoveryStatusSchema>;

/** Free-text notes upper bound (mirrors the other free-text caps in the app). */
const NOTES_MAX = 2_000;

/** Canonical wire shape returned by the API ({ data } envelope). */
export const DiscoveryRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  apartmentId: z.string().uuid(),
  status: DiscoveryStatusSchema,
  notes: z.string().max(NOTES_MAX).nullable(),
  // §6 DEFERRED slots — always null this slice (never populated; never in the
  // create/update DTOs). Surfaced read-side so the wire shape is stable when the
  // audio/transcript feature lands later.
  recordingRef: z.string().nullable(),
  transcript: z.string().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type DiscoveryRecord = z.infer<typeof DiscoveryRecordSchema>;

/**
 * Create a discovery record on an apartment (POST
 * /apartments/:id/discovery-records). status defaults to 'not_visited'.
 * recording_ref / transcript are §6 DEFERRED — deliberately NOT in this DTO.
 */
export const CreateDiscoveryRecordInput = z
  .object({
    status: DiscoveryStatusSchema.default('not_visited'),
    notes: z.string().max(NOTES_MAX).nullable().optional(),
  })
  .strict();
export type CreateDiscoveryRecord = z.infer<typeof CreateDiscoveryRecordInput>;

/**
 * Update a discovery record (PATCH /discovery-records/:id) — status + notes
 * only. At least one field; recording_ref / transcript stay DEFERRED.
 */
export const UpdateDiscoveryRecordInput = z
  .object({
    status: DiscoveryStatusSchema.optional(),
    notes: z.string().max(NOTES_MAX).nullable().optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.notes !== undefined, {
    message: 'at least one of status / notes must be provided',
  });
export type UpdateDiscoveryRecord = z.infer<typeof UpdateDiscoveryRecordInput>;
