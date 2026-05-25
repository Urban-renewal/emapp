/**
 * Signature-requests API client (D.12 LAW — Manager side).
 *
 * Manager flow:
 *   1. POST /signature-requests — create + receive signUrl (one-shot
 *      reveal; bearer JWT for the resident). Idempotency-Key auto-
 *      minted per call so a double-clicked "send signature link"
 *      doesn't fire two requests + two delivery channels.
 *   2. GET /signature-requests — list with status filter / cursor.
 *   3. GET /signature-requests/:id — single row (post-create or refresh).
 *   4. POST /signature-requests/:id/cancel — cancel pending; idempotent
 *      on already-cancelled (200); 409 `signature_request_already_signed`
 *      on signed.
 *
 * SECURITY: `signUrl` is a bearer credential (full JWT, 7d TTL). The
 * FE shows it ONCE at create time; the list/detail wire shape never
 * carries it back. We do not log it anywhere (Sentry redaction
 * handles the URL field by default; defense in depth: the Manager UI
 * has a "copied to clipboard" affordance + a "regenerate" warning if
 * they accidentally close before copying).
 */
import {
  CreateSignatureRequestInput,
  SignatureRequestCreateResponseSchema,
  SignatureRequestSchema,
  type CreateSignatureRequest,
  type ListSignatureRequestsQueryDto,
  type SignatureRequest,
  type SignatureRequestCreateResponse,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';

const SignatureRequestDataSchema = z.object({ data: SignatureRequestSchema });
const CreateResponseDataSchema = z.object({ data: SignatureRequestCreateResponseSchema });

export interface SignatureRequestListPage {
  items: SignatureRequest[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listSignatureRequests(
  query: Partial<ListSignatureRequestsQueryDto> = {},
): Promise<SignatureRequestListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.status) params.set('status', query.status);
  if (query.documentId) params.set('documentId', query.documentId);
  if (query.ownerId) params.set('ownerId', query.ownerId);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/signature-requests${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(SignatureRequestSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function getSignatureRequest(id: string): Promise<SignatureRequest> {
  const res = await apiClient.get<unknown>(`/signature-requests/${id}`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return SignatureRequestDataSchema.parse({ data: res.data }).data;
}

export async function createSignatureRequest(
  body: CreateSignatureRequest,
): Promise<SignatureRequestCreateResponse> {
  CreateSignatureRequestInput.parse(body);
  const res = await apiClient.postIdempotent<unknown>(`/signature-requests`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return CreateResponseDataSchema.parse({ data: res.data }).data;
}

/** POST /signature-requests/:id/cancel — idempotent on cancelled,
 *  409 `signature_request_already_signed` on signed. */
export async function cancelSignatureRequest(id: string): Promise<SignatureRequest> {
  const res = await apiClient.post<unknown>(`/signature-requests/${id}/cancel`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return SignatureRequestDataSchema.parse({ data: res.data }).data;
}
