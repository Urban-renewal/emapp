/**
 * Proposals API client — Autonomous Master Plan, Phase 1 (the Approval Inbox).
 *
 * Routes (manager-only; RLS-scoped to the actor's org):
 *   GET  /api/v1/proposals          → { data: ProposalView[], page }  (keyset)
 *   POST /api/v1/proposals/:id/approve → { data: ProposalView }
 *   POST /api/v1/proposals/:id/reject  → { data: ProposalView }
 *
 * Defensive Zod parse on EVERY response (ARCHITECTURE-MAP §1): the wire shape
 * is re-validated here even though the BE owns the contract — a drift surfaces
 * as a parse error, never silently mis-rendered. `evidence` is PII-free by BE
 * contract (ids/counts/timestamps only); we never assume otherwise on the FE.
 *
 * APPROVE applies a real action (re-issues a signing link), so it goes through
 * `postIdempotent` — a double-click / retry re-sends the SAME Idempotency-Key
 * and the BE de-dups. REJECT is a pure state flip (the BE 409s a non-pending
 * row), so it needs no idempotency key.
 */
import {
  ProposalApproveResponseSchema,
  ProposalSchema,
  type ProposalApproveResponse,
  type ProposalView,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';

const ProposalDataSchema = z.object({ data: ProposalSchema });
const ProposalApproveDataSchema = z.object({ data: ProposalApproveResponseSchema });

export interface ProposalListPage {
  items: ProposalView[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export interface ListProposalsQuery {
  limit?: number;
  cursor?: string;
  /** Optionally narrow to one action kind (e.g. `signature_request.reissue`). */
  kind?: string;
}

const PendingCountDataSchema = z.object({
  data: z.object({ count: z.number().int().nonnegative() }),
});

/**
 * GET /api/v1/proposals/pending-count → the org-wide count of PENDING proposals.
 * Constant-time on the BE (partial index), so the inbox header states the TRUE
 * magnitude — NOT the ≤25-row page length it counted before. Mirrors the
 * notifications unread-count client call. Defensive Zod parse (ARCHITECTURE-MAP
 * §1): a drift surfaces as a parse error, never a silently-wrong header.
 */
export async function proposalsPendingCount(): Promise<{ count: number }> {
  const res = await apiClient.get<unknown>('/proposals/pending-count');
  if (!isOk(res)) throw new ApiClientError(res.error);
  return PendingCountDataSchema.parse({ data: res.data }).data;
}

export async function listProposals(query: ListProposalsQuery = {}): Promise<ProposalListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.kind) params.set('kind', query.kind);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/proposals${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(ProposalSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

/** APPROVE — replays the gated action (BE re-checks the boundary). Idempotent
 *  key minted by `postIdempotent` so a retry can't double-apply.
 *
 *  Returns the applied `ProposalApproveResponse` — the proposal view PLUS, for
 *  contact-producing kinds (e.g. `signature_request.reissue`), the optional
 *  `delivery` OUTCOME (so the inbox can confirm the owner WAS re-contacted, with
 *  the governed-outbound `state` + masked `recipient`). Defensive Zod parse here
 *  (ARCHITECTURE-MAP §1): a drift in the new `delivery` shape surfaces as a parse
 *  error, never a silently-dropped outcome. `delivery` is `undefined` for
 *  internal-only kinds. */
export async function approveProposal(id: string): Promise<ProposalApproveResponse> {
  const res = await apiClient.postIdempotent<unknown>(`/proposals/${id}/approve`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ProposalApproveDataSchema.parse({ data: res.data }).data;
}

/** REJECT — dismiss the proposal (state flip; the BE 409s a non-pending row). */
export async function rejectProposal(id: string): Promise<ProposalView> {
  const res = await apiClient.post<unknown>(`/proposals/${id}/reject`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ProposalDataSchema.parse({ data: res.data }).data;
}
