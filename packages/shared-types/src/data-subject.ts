import { z } from 'zod';

// Data-subject rights contracts (P0.C1) — Israeli Privacy Protection Law
// "right to access" + "right to erasure" (right-to-be-forgotten).
//
// PURE Zod (no @emapp/* imports). Both schemas are returned ONLY by the
// manager-gated, audited owner data-subject endpoints:
//   - GET  /owners/:id/data-export → OwnerDataExportSchema (a PII REVEAL)
//   - POST /owners/:id/erase       → OwnerErasureResultSchema
//
// NOTE: OwnerDataExportSchema deliberately carries CLEARTEXT PII (national_id,
// phone, name) — it IS the subject-access response. It is NOT a list/detail
// shape and must never substitute for the masked OwnerSchema. Access is gated
// by `view_owner_pii` (manager always) and audited as a reveal.

/** One ownership the subject holds (apartment ↔ owner), with project context. */
export const DataExportOwnershipSchema = z.object({
  ownershipId: z.string().uuid(),
  apartmentId: z.string().uuid(),
  apartmentNumber: z.string(),
  buildingId: z.string().uuid(),
  buildingAddress: z.string(),
  projectId: z.string().uuid(),
  projectName: z.string(),
  ownershipPct: z.number(),
  relationship: z.string(),
  role: z.string().nullable(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().nullable(),
});
export type DataExportOwnership = z.infer<typeof DataExportOwnershipSchema>;

/**
 * One signature EVENT the subject produced. Non-PII forensic metadata + the
 * document hash (legal proof). The signature SVG blob itself is NOT included
 * (it is the subject's own biometric mark; the access response carries the
 * EVENT record, not the raw mark — kept out to avoid re-exfiltrating a
 * signature image through the access channel).
 */
export const DataExportSignatureSchema = z.object({
  signatureId: z.string().uuid(),
  documentId: z.string().uuid(),
  documentName: z.string().nullable(),
  documentHash: z.string(),
  authMethod: z.string(),
  signedAt: z.coerce.date(),
});
export type DataExportSignature = z.infer<typeof DataExportSignatureSchema>;

/**
 * The full "data subject access response": EVERYTHING EMAPP holds about one
 * owner — decrypted PII + their ownerships + signature events + the
 * projects/apartments they are tied to. Assembled inside withTenant, audited as
 * a PII reveal (`owner.data_exported`).
 */
export const OwnerDataExportSchema = z.object({
  exportedAt: z.coerce.date(),
  owner: z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    // CLEARTEXT — this is the subject-access response (see file header).
    name: z.string(),
    nationalId: z.string(),
    phone: z.string().nullable(),
    email: z.string().email().nullable(),
    notes: z.string().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    archivedAt: z.coerce.date().nullable(),
    erasedAt: z.coerce.date().nullable(),
  }),
  ownerships: z.array(DataExportOwnershipSchema),
  signatures: z.array(DataExportSignatureSchema),
});
export type OwnerDataExport = z.infer<typeof OwnerDataExportSchema>;

/**
 * Optional reason body for an erasure request (compliance note, e.g. the
 * subject's request ticket). NEVER carries PII. `.strict()` fail-closed.
 */
export const OwnerEraseInput = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();
export type OwnerErase = z.infer<typeof OwnerEraseInput>;

/**
 * Erasure result. `alreadyErased` is true when the call was a no-op (idempotent
 * re-erase). `clearedFields` enumerates the PII field-categories crypto-shredded
 * (NAMES only, never values). `signaturesRetained` / `ownershipsRetained` are
 * the counts KEPT in place (anonymized, not deleted) for legal validity.
 */
export const OwnerErasureResultSchema = z.object({
  ownerId: z.string().uuid(),
  erasedAt: z.coerce.date(),
  alreadyErased: z.boolean(),
  clearedFields: z.array(z.string()),
  signaturesRetained: z.number().int().nonnegative(),
  ownershipsRetained: z.number().int().nonnegative(),
});
export type OwnerErasureResult = z.infer<typeof OwnerErasureResultSchema>;
