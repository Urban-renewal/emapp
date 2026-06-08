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
  SignatureRequestLinkResponseSchema,
  SignatureRequestSchema,
  type CreateSignatureRequest,
  type ListSignatureRequestsQueryDto,
  type SignatureRequest,
  type SignatureRequestCreateResponse,
  type SignatureRequestLinkResponse,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';

const SignatureRequestDataSchema = z.object({ data: SignatureRequestSchema });
const CreateResponseDataSchema = z.object({ data: SignatureRequestCreateResponseSchema });
const LinkResponseDataSchema = z.object({ data: SignatureRequestLinkResponseSchema });

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

/**
 * Download the SIGNED ARTIFACT — a generated signature-certificate PDF. The
 * endpoint streams a binary (not the {data} envelope), so we fetch it raw
 * (same-origin → cookie carried) and hand back a Blob. Only a SIGNED request
 * has one (else 404). The caller triggers the browser save.
 */
export async function fetchSignedDocument(id: string): Promise<Blob> {
  const res = await fetch(`/api/v1/signature-requests/${id}/signed-document`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/pdf' },
  });
  if (!res.ok) {
    throw new ApiClientError({ code: res.status === 404 ? 'not_found' : 'download_failed' });
  }
  return res.blob();
}

export async function createSignatureRequest(
  body: CreateSignatureRequest,
): Promise<SignatureRequestCreateResponse> {
  CreateSignatureRequestInput.parse(body);
  const res = await apiClient.postIdempotent<unknown>(`/signature-requests`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return CreateResponseDataSchema.parse({ data: res.data }).data;
}

/**
 * POST /signature-requests/:id/link — RETRIEVE the signing link for a PENDING
 * request, to deliver OUT-OF-BAND (P4 phone-less owner). Re-mints a fresh token
 * (the previously-sent link dies) and returns `{ request, signUrl }`.
 *
 * SECURITY: `signUrl` is a BEARER credential (full JWT). The caller copies it to
 * the clipboard and must NOT persist it in the DOM longer than needed; never log
 * it. 409 `signature_request_already_signed` / `signature_request_already_cancelled`
 * if the request is no longer pending (the FE only offers this for pending).
 */
export async function retrieveSignatureLink(id: string): Promise<SignatureRequestLinkResponse> {
  const res = await apiClient.post<unknown>(`/signature-requests/${id}/link`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return LinkResponseDataSchema.parse({ data: res.data }).data;
}

/** POST /signature-requests/:id/cancel — idempotent on cancelled,
 *  409 `signature_request_already_signed` on signed. */
export async function cancelSignatureRequest(id: string): Promise<SignatureRequest> {
  const res = await apiClient.post<unknown>(`/signature-requests/${id}/cancel`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return SignatureRequestDataSchema.parse({ data: res.data }).data;
}
