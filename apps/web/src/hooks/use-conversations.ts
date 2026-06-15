'use client';

import type { CreateConversation } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createConversation,
  listConversations,
  listMessages,
  markConversationRead,
  sendMessage,
  type ConversationListPage,
  type MessageListPage,
} from '@/lib/api/conversations';

const CONVERSATIONS_KEY = ['conversations'] as const;

/**
 * The conversation list. No WebSocket infra in this MVP (no Redis), so
 * near-real-time = polling: refetch every 15s (and on window focus) so a new
 * thread / incoming message + its unread badge surface without a manual reload.
 */
export function useConversationList(query: { limit?: number; cursor?: string } = {}) {
  return useQuery<ConversationListPage, Error>({
    queryKey: [...CONVERSATIONS_KEY, 'list', query],
    queryFn: () => listConversations(query),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

/**
 * Messages of the OPEN thread. Polled faster (8s) than the list because it's
 * the focused surface; disabled until a conversation is selected.
 */
export function useMessages(conversationId: string | undefined) {
  return useQuery<MessageListPage, Error>({
    queryKey: [...CONVERSATIONS_KEY, 'messages', conversationId],
    queryFn: () => {
      if (!conversationId) throw new Error('useMessages requires a conversationId');
      return listMessages(conversationId, { limit: 50 });
    },
    enabled: Boolean(conversationId),
    staleTime: 5_000,
    refetchInterval: 8_000,
  });
}

export function useCreateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateConversation) => createConversation(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
  });
}

export function useSendMessage(conversationId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => {
      if (!conversationId) throw new Error('useSendMessage requires a conversationId');
      return sendMessage(conversationId, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...CONVERSATIONS_KEY, 'messages', conversationId] });
      qc.invalidateQueries({ queryKey: [...CONVERSATIONS_KEY, 'list'] });
    },
  });
}

export function useMarkConversationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => markConversationRead(conversationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...CONVERSATIONS_KEY, 'list'] });
    },
  });
}
