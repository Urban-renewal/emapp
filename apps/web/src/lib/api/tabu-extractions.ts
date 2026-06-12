/**
 * Tabu-extraction API client (Phase-5 7a/7b/7c — נסח-טאבו → בעלות).
 *
 * Wire contract (apps/api/src/modules/tabu/tabu-extractions.controller.ts):
 *  - GET  /apartments/:apartmentId/tabu-extractions       → list (D.16 page)
 *  - POST /apartments/:apartmentId/tabu-extractions       → create draft
 *  - POST /tabu-extractions/:id/extract                   → run the engine
 *  - GET  /tabu-extractions/:id/rows                      → DECRYPTED review
 *    rows — 403 `pii_step_up_required` without a valid per-session unlock;
 *    `nationalId` arrives •-masked for masked-fidelity actors (D.19/D.47).
 *  - PATCH /tabu-extractions/:id/rows/:rowId              → edit one row
 *  - POST /tabu-extractions/:id/confirm                   → THE commit
 *    (idempotent: a second confirm → 409 `tabu_extraction_not_draft`).
 *
 * Security:
 *  - rows/PATCH/confirm calls are expected to be wrapped in the F1
 *    `useStepUpUnlock().withStepUp` at the call site (the unlock modal).
 *  - A MASKED `nationalId` (contains '•') must NEVER round-trip into a
 *    PATCH body — enforced at the review-table UI (read-only field) and
 *    nothing here ever auto-copies row values into patches.
 */
import {
  TabuExtractionReviewRowSchema,
  TabuExtractionSchema,
  type CreateTabuExtraction,
  type TabuExtraction,
  type TabuExtractionReviewRow,
  type UpdateTabuExtractionRow,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError } from './errors';
import { PageSchema, type ListPage } from './paging';

/** 409 code for confirm/edit on a non-draft extraction — the IDEMPOTENCY
 *  contract of confirm, surfaced as "already confirmed", not as a failure. */
export const TABU_NOT_DRAFT_CODE = 'tabu_extraction_not_draft' as const;

export async function listTabuExtractions(
  apartmentId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<ListPage<TabuExtraction>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(
    `/apartments/${apartmentId}/tabu-extractions${qs ? `?${qs}` : ''}`,
  );
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  return {
    items: z.array(TabuExtractionSchema).parse(res.data),
    page: PageSchema.parse(res.page),
  };
}

/** POST /apartments/:id/tabu-extractions — create a 'draft' envelope on a
 *  FINALIZED, apartment-scoped source document. Idempotency-keyed (§v9-P0-3,
 *  create-style POST). */
export async function createTabuExtraction(
  apartmentId: string,
  body: CreateTabuExtraction,
): Promise<TabuExtraction> {
  const res = await apiClient.postIdempotent<unknown>(
    `/apartments/${apartmentId}/tabu-extractions`,
    body,
  );
  if (!isOk(res)) throw new ApiClientError(res.error);
  return TabuExtractionSchema.parse(res.data);
}

const RunResultSchema = z.object({ rowCount: z.number().int(), engineId: z.string() });
export type TabuRunResult = z.infer<typeof RunResultSchema>;

/** POST /tabu-extractions/:id/extract — run the pluggable engine (stub in
 *  MVP — zero egress) on the draft's source נסח. */
export async function runTabuExtraction(id: string): Promise<TabuRunResult> {
  const res = await apiClient.post<unknown>(`/tabu-extractions/${id}/extract`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return RunResultSchema.parse(res.data);
}

/** GET /tabu-extractions/:id/rows — decrypted review rows. Requires a valid
 *  per-session PII unlock (403 `pii_step_up_required` otherwise — wrap the
 *  call in `withStepUp`). */
export async function listTabuExtractionRows(id: string): Promise<TabuExtractionReviewRow[]> {
  const res = await apiClient.get<unknown>(`/tabu-extractions/${id}/rows`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return z.array(TabuExtractionReviewRowSchema).parse(res.data);
}

/** PATCH /tabu-extractions/:id/rows/:rowId — edit a parsed row pre-confirm
 *  (re-encrypts server-side, edited=true). Same unlock gate as rows. */
export async function updateTabuExtractionRow(
  id: string,
  rowId: string,
  patch: UpdateTabuExtractionRow,
): Promise<void> {
  const res = await apiClient.patch<unknown>(`/tabu-extractions/${id}/rows/${rowId}`, patch);
  if (!isOk(res)) throw new ApiClientError(res.error);
}

/** POST /tabu-extractions/:id/confirm — audit-first, atomic commit: matches/
 *  creates owners + REPLACES the apartment's ownerships with the confirmed
 *  fractions (+ provenance). 409 `tabu_extraction_not_draft` on a repeat. */
export async function confirmTabuExtraction(id: string): Promise<TabuExtraction> {
  const res = await apiClient.post<unknown>(`/tabu-extractions/${id}/confirm`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return TabuExtractionSchema.parse(res.data);
}
