/**
 * Member API client — Phase 4c S1.
 *
 * BE contract:
 *   GET    /api/v1/members            → { data: Member[], page: {...} }
 *   POST   /api/v1/members            → { data: { member: Member, inviteToken?: string } }
 *                                       (D.27 — inviteToken present only outside prod)
 *   PATCH  /api/v1/members/:userId    → { data: Member }
 *   DELETE /api/v1/members/:userId    → 204 (no body)
 *   POST   /api/v1/auth/accept-invite → { data: { ok: true } }   (PUBLIC)
 *
 * D.27 invite-token note:
 *   The token field arrives in the create-response ONLY in non-prod
 *   environments (EXPOSE_INVITE_TOKEN). In production the email channel
 *   is the sole delivery path. The FE renders the token ONCE in the
 *   create flow (never persisted to TanStack cache, never re-displayed
 *   on the list/detail reads — the server doesn't return it on those
 *   reads even in dev).
 *
 * Defensive Zod parse on every response (per docs/ARCHITECTURE-MAP §1).
 */
import {
  AcceptInviteInput,
  MemberSchema,
  UpdateAgentCapabilitiesInput,
  type AcceptInvite,
  type CreateMember,
  type Member,
  type UpdateAgentCapabilities,
  type UpdateMember,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

export interface MemberListPage {
  items: Member[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

/** Create-response shape: a `Member` plus an optional one-shot
 *  `inviteToken` (D.27 — present only outside production). The wire
 *  envelope wraps this as `{ data: CreateMemberResult }`. */
const CreateMemberResultSchema = z.object({
  member: MemberSchema,
  inviteToken: z.string().min(10).max(4096).optional(),
});
const CreateMemberWireSchema = z.object({ data: CreateMemberResultSchema });
const MemberDataSchema = z.object({ data: MemberSchema });

export interface CreateMemberResult {
  member: Member;
  /** Present ONLY in non-prod (D.27 — EXPOSE_INVITE_TOKEN). Show once,
   *  never re-fetch — the server does not return it on subsequent
   *  reads. Never store in TanStack cache (the mutation result is
   *  ephemeral by design). */
  inviteToken?: string;
}

export async function listMembers(
  query: { limit?: number; cursor?: string } = {},
): Promise<MemberListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/members${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(MemberSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function createMember(body: CreateMember): Promise<CreateMemberResult> {
  // §v9-P0-3 — idempotent create POST so a double-clicked Submit
  // creates ONE invite, not two.
  const res = await apiClient.postIdempotent<unknown>(`/members`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return CreateMemberWireSchema.parse({ data: res.data }).data;
}

export async function updateMemberRole(userId: string, body: UpdateMember): Promise<Member> {
  const res = await apiClient.patch<unknown>(`/members/${userId}`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return MemberDataSchema.parse({ data: res.data }).data;
}

/**
 * D.46/D.54 — PATCH a member's agent capability set. The BE accepts a
 * SUBSET merged onto the stored set and re-validates the invariant
 * `view_owner_pii ⇒ view_owners` (400 `view_owner_pii_requires_view_owners`)
 * + that the target is `role='agent'` (400 `capabilities_agent_only`).
 * Defensive body parse before the wire.
 */
export async function updateMemberCapabilities(
  userId: string,
  body: UpdateAgentCapabilities,
): Promise<Member> {
  const validated = UpdateAgentCapabilitiesInput.parse(body);
  const res = await apiClient.patch<unknown>(`/members/${userId}/capabilities`, validated);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return MemberDataSchema.parse({ data: res.data }).data;
}

export async function revokeMember(userId: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/members/${userId}`);
  // 204 returns an empty body → api-client folds it as
  // `invalid_response`. Treat that as success for DELETE (same pattern
  // as archiveProject — projects.ts:65-74).
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return;
  throw new ApiClientError(res.error);
}

/** PUBLIC — invitee accepts the invite with their own password.
 *  Defensive client-side parse of the BODY before POST so a malformed
 *  client value never reaches the wire (Doc 06 §5 pattern). */
export async function acceptInvite(body: AcceptInvite): Promise<{ ok: true }> {
  const validated = AcceptInviteInput.parse(body);
  const res = await apiClient.post<unknown>(`/auth/accept-invite`, validated, {
    // Never attempt silent refresh on this endpoint — it's public
    // (no session yet); a 401 here would otherwise needlessly hit
    // /auth/refresh and surface noise. The actual contract is 200/400.
    noRefresh: true,
  });
  if (isOk(res)) return { ok: true };
  throw new ApiClientError(res.error);
}
