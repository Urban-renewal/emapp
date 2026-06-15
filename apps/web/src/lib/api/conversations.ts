/**
 * Team messaging API client (Slice 2).
 *
 * Routes (org-scoped, participation-gated):
 *   GET  /api/v1/conversations                 → { data: Conversation[], page }
 *   POST /api/v1/conversations                 → { data: Conversation }   (Manager/Agent)
 *   GET  /api/v1/conversations/:id             → { data: Conversation }
 *   GET  /api/v1/conversations/:id/messages    → { data: Message[], page }
 *   POST /api/v1/conversations/:id/messages    → { data: Message }        (Manager/Agent)
 *   POST /api/v1/conversations/:id/read         → 204
 *
 * Defensive Zod parse on every response (per docs/ARCHITECTURE-MAP §1).
 */
import {
  ConversationSchema,
  MessageSchema,
  type Conversation,
  type CreateConversation,
  type Message,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

const ConversationDataSchema = z.object({ data: ConversationSchema });
const MessageDataSchema = z.object({ data: MessageSchema });

export interface ConversationListPage {
  items: Conversation[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export interface MessageListPage {
  items: Message[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listConversations(
  query: { limit?: number; cursor?: string } = {},
): Promise<ConversationListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/conversations${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(ConversationSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function getConversation(id: string): Promise<Conversation> {
  const res = await apiClient.get<unknown>(`/conversations/${id}`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ConversationDataSchema.parse({ data: res.data }).data;
}

export async function listMessages(
  conversationId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<MessageListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(
    `/conversations/${conversationId}/messages${qs ? `?${qs}` : ''}`,
  );
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(MessageSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function createConversation(body: CreateConversation): Promise<Conversation> {
  // Idempotent create POST so a double-clicked "start" makes ONE thread.
  const res = await apiClient.postIdempotent<unknown>(`/conversations`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ConversationDataSchema.parse({ data: res.data }).data;
}

export async function sendMessage(conversationId: string, body: string): Promise<Message> {
  const res = await apiClient.postIdempotent<unknown>(`/conversations/${conversationId}/messages`, {
    body,
  });
  if (!isOk(res)) throw new ApiClientError(res.error);
  return MessageDataSchema.parse({ data: res.data }).data;
}

export async function markConversationRead(conversationId: string): Promise<void> {
  // 204 → empty body folds as `invalid_response`; treat as success (same
  // pattern as archiveNote / revokeMember).
  const res = await apiClient.post<unknown>(`/conversations/${conversationId}/read`, {});
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return;
  throw new ApiClientError(res.error);
}
