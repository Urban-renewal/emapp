/**
 * Project API client — wraps the D.16 envelope around the typed
 * shared-types schemas. Defensive `.parse()` on every response per
 * docs/ARCHITECTURE-MAP §1 (the FE doesn't trust the wire).
 *
 * Each function returns either the unwrapped data or throws an
 * `ApiClientError` carrying the D.16 `{ code, message?, details? }`
 * envelope so TanStack Query (or a manual caller) can `error.code`-
 * switch without parsing strings.
 */
import {
  ApartmentHoldoutsResponseSchema,
  ApartmentSignatureProgressSchema,
  ProjectListItemSchema,
  ProjectSchema,
  SignatureProgressSchema,
  type ApartmentHoldout,
  type ApartmentSignatureProgress,
  type CreateProject,
  type Project,
  type ProjectListItem,
  type ProjectSegment,
  type ProjectStatus,
  type SignatureProgress,
  type UpdateProject,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk, type ApiResponse } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

// Write paths (create/archive) still return the bare Project shape.
const ProjectDataSchema = z.object({ data: ProjectSchema });
// list+get carry aggregate stats — must parse against ProjectListItem,
// not ProjectSchema, or Zod strips the stats fields by default and the
// FE renders "—" everywhere even when the API has real numbers.
const ProjectListItemDataSchema = z.object({ data: ProjectListItemSchema });

export interface ProjectListPage {
  items: ProjectListItem[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

// §SOLID-M5 — ApiClientError now lives in `./errors`. This re-export
// keeps the 8 sibling entity files (and tests) working without an
// import sweep; new code should import from `./errors` directly.
export { ApiClientError } from './errors';

function unwrap<T>(res: ApiResponse<T>): T {
  if (isOk(res)) return res.data;
  throw new ApiClientError(res.error);
}

/**
 * NS6 (MASTER-PLAN-V13 Wave C) — wires the NS1 server-side search/filter
 * params. ALL optional + additive: with none set the request is the exact
 * pre-NS1 `GET /projects?limit=25` (same rows, same keyset order). `q` is a
 * name substring (BE trigram ILIKE; trimmed + bounded server-side), `status`
 * is the D.18 enum, `segment` is an NS1 SYSTEM segment (stalled/expiring/mine).
 * None are PII — project names/status/segment are org-scoped, not owner PII —
 * so they ride the query string (Doc 07 §7.10 bans PII in the URL, not these).
 * Cursor pagination is preserved verbatim (NS1 stays keyset).
 */
export async function listProjects(query: {
  limit?: number;
  cursor?: string;
  q?: string;
  status?: ProjectStatus;
  segment?: ProjectSegment;
}): Promise<ProjectListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  // Trim + omit empty so an all-whitespace box is "no filter" (BE treats it
  // the same, but omitting keeps the URL + the cache key clean).
  const q = query.q?.trim();
  if (q) params.set('q', q);
  if (query.status) params.set('status', query.status);
  if (query.segment) params.set('segment', query.segment);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/projects${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(ProjectListItemSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function getProject(id: string): Promise<ProjectListItem> {
  const res = await apiClient.get<unknown>(`/projects/${id}`);
  const data = unwrap(res);
  return ProjectListItemDataSchema.parse({ data }).data;
}

// Phase-6 "תמונת מצב" — read-only signature-progress board (S5a). NO PII on the
// wire: only counts + the project's own target/derived percentages.
const SignatureProgressDataSchema = z.object({ data: SignatureProgressSchema });

export async function getSignatureProgress(id: string): Promise<SignatureProgress> {
  const res = await apiClient.get<unknown>(`/projects/${id}/signature-progress`);
  const data = unwrap(res);
  return SignatureProgressDataSchema.parse({ data }).data;
}

// S5d — per-apartment drill-down under the 5a board (read-only). NO PII on the
// wire: only apartment designation (number/floor) + owner counts + status.
const ApartmentSignatureProgressListSchema = z.object({
  data: z.array(ApartmentSignatureProgressSchema),
});

export async function getSignatureProgressApartments(
  id: string,
): Promise<ApartmentSignatureProgress[]> {
  const res = await apiClient.get<unknown>(`/projects/${id}/signature-progress/apartments`);
  const data = unwrap(res);
  return ApartmentSignatureProgressListSchema.parse({ data }).data;
}

// E2 Wave-2 E2.2-S3 / B4 — apartment HOLDOUTS ("מי תקוע / who's stuck"): the
// NAMED list of an apartment's active owners who have NOT signed. This is the
// ONLY signature-progress surface that returns owner NAMES, so it is
// `view_owner_pii`-gated + AUDITED on the BE. The FE therefore loads it ON DEMAND
// (when the caller expands an apartment), never eagerly for the whole board. A
// caller lacking the capability gets a 403 → `ApiClientError` with
// code 'forbidden', which the hook/component renders as the NO-NAME fallback
// ("דירה N · partial"). Returns ownerId + name + apartmentNumber ONLY — never
// national_id / phone.
const ApartmentHoldoutsDataSchema = z.object({ data: ApartmentHoldoutsResponseSchema });

export async function getApartmentHoldouts(
  projectId: string,
  apartmentId: string,
): Promise<ApartmentHoldout[]> {
  const res = await apiClient.get<unknown>(
    `/projects/${projectId}/signature-progress/apartments/${apartmentId}/holdouts`,
  );
  const data = unwrap(res);
  return ApartmentHoldoutsDataSchema.parse({ data }).data.holdouts;
}

export async function createProject(body: CreateProject): Promise<Project> {
  // §v9-P0-3 — create POSTs carry an Idempotency-Key so a
  // double-clicked Submit creates ONE project, not two.
  const res = await apiClient.postIdempotent<unknown>(`/projects`, body);
  const data = unwrap(res);
  return ProjectDataSchema.parse({ data }).data;
}

// E2 Wave-1 B5 — the project status state-machine + optimistic-concurrency
// codes the BE may now return on PATCH. Exported so the edit form maps them to
// clear Hebrew messages (i18n) instead of a generic failure toast. `unwrap`
// already throws an `ApiClientError` carrying the D.16 `code`, so callers
// switch on `error.code` against these constants.
export const PROJECT_UPDATE_ERROR_CODES = {
  invalidStatusTransition: 'invalid_status_transition',
  thresholdNotMet: 'threshold_not_met',
  staleWrite: 'stale_write',
} as const;

/**
 * E2 Wave-1 B5 — PATCH a project. The `body.expectedUpdatedAt` (the `updated_at`
 * the caller last read) drives the BE optimistic-concurrency check; a stale
 * value throws `ApiClientError` with code `stale_write`. An illegal status
 * change throws `invalid_status_transition`; a `→approved` below the consent
 * target throws `threshold_not_met`. The response carries the NEW `updatedAt`
 * so the caller can chain a follow-up edit.
 */
export async function updateProject(id: string, body: UpdateProject): Promise<Project> {
  const res = await apiClient.patch<unknown>(`/projects/${id}`, body);
  const data = unwrap(res);
  return ProjectDataSchema.parse({ data }).data;
}

export async function archiveProject(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/projects/${id}`);
  // 204 returns an empty body → api-client's invalid-JSON branch wraps
  // it as `{ error: { code: 'invalid_response' } }`. That's expected
  // and harmless for a 204; treat the call as success when the only
  // error is the empty-body code.
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return;
  throw new ApiClientError(res.error);
}
