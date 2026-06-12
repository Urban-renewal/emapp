import { z } from 'zod';

// S7a — tabu_extractions contract (Doc 11 SoT). The ENVELOPE around a single
// Tabu (נסח טאבו) extraction run on an apartment: it points at the FINALIZED
// source document the parse will read and carries a draft→confirmed/discarded
// lifecycle. Envelope ONLY this slice — NO parse, NO owner/share PII rows, NO
// commit (those are slices 7b/7c). The wire shape therefore carries no PII.

// Closed lifecycle enum. Authoritative API-edge enforcement (mirrors the DB
// CHECK on tabu_extractions.status, migration 0068).
export const TabuExtractionStatusSchema = z.enum(['draft', 'confirmed', 'discarded']);
export type TabuExtractionStatus = z.infer<typeof TabuExtractionStatusSchema>;

/** Canonical wire shape returned by the API ({ data } envelope). */
export const TabuExtractionSchema = z.object({
  id: z.string().uuid(),
  apartmentId: z.string().uuid(),
  sourceDocumentId: z.string().uuid(),
  status: TabuExtractionStatusSchema,
  createdBy: z.string().uuid(),
  createdAt: z.coerce.date(),
  // NULL on a fresh draft; stamped when the draft is confirmed (7c).
  confirmedAt: z.coerce.date().nullable(),
});
export type TabuExtraction = z.infer<typeof TabuExtractionSchema>;

/**
 * Create an extraction envelope on an apartment (POST
 * /apartments/:id/tabu-extractions). The body names the FINALIZED source
 * document; the service validates it is finalized (uploaded_at NOT NULL AND
 * scan_status='clean') AND scoped to this apartment before creating a 'draft'.
 */
export const CreateTabuExtractionInput = z
  .object({
    documentId: z.string().uuid(),
  })
  .strict();
export type CreateTabuExtraction = z.infer<typeof CreateTabuExtractionInput>;

/**
 * S7c — one DECRYPTED parsed row as served by GET /tabu-extractions/:id/rows
 * (behind a VALID per-session PII unlock; nationalId is •-masked for callers
 * whose owner-PII fidelity resolves to 'masked', D.19/D.47/D.54).
 */
export const TabuExtractionReviewRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  nationalId: z.string().nullable(),
  shareNumerator: z.number().int().nullable(),
  shareDenominator: z.number().int().nullable(),
  confidence: z.number().nullable(),
  edited: z.boolean(),
  position: z.number().int(),
});
export type TabuExtractionReviewRow = z.infer<typeof TabuExtractionReviewRowSchema>;

/**
 * S7c — PATCH /tabu-extractions/:id/rows/:rowId body. Review-screen edit of a
 * parsed row BEFORE confirm: PII values are re-encrypted server-side
 * (pgcrypto) and the row is marked edited=true. Draft-only. At least one
 * field must be present (an empty patch is a no-op and is rejected).
 */
export const UpdateTabuExtractionRowInput = z
  .object({
    name: z.string().min(1).max(200).optional(),
    nationalId: z.string().min(1).max(20).optional(),
    shareNumerator: z.number().int().min(0).optional(),
    shareDenominator: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'at least one field is required',
  });
export type UpdateTabuExtractionRow = z.infer<typeof UpdateTabuExtractionRowInput>;
