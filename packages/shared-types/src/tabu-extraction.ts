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
