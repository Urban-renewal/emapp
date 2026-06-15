import { z } from 'zod';

// Canonical contract for internal team messaging (Slice 1).
//
// Member ↔ member conversations, org-scoped. Authorization is participation-
// based (RLS + service layer), NOT the IAM capability matrix. Viewer is
// read-only (cannot create a conversation or send a message) — enforced in the
// service. Message bodies are member-internal collaboration text (NOT PII):
// they are never placed in notifications and are RLS-scoped to participants.

/** A single message in a conversation. */
export const MessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  senderId: z.string().uuid(),
  body: z.string().min(1).max(5000),
  createdAt: z.coerce.date(),
});
export type Message = z.infer<typeof MessageSchema>;

/** A compact preview of a conversation's most recent message (list view). */
export const MessagePreviewSchema = z
  .object({
    id: z.string().uuid(),
    senderId: z.string().uuid(),
    body: z.string(),
    createdAt: z.coerce.date(),
  })
  .nullable();
export type MessagePreview = z.infer<typeof MessagePreviewSchema>;

/**
 * A conversation as the requesting member sees it: the thread envelope plus
 * the member-relative `unreadCount` and the `lastMessage` preview, and the
 * full participant id list (the UI resolves names from the members roster).
 */
export const ConversationSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  title: z.string().min(1).max(120).nullable(),
  createdBy: z.string().uuid(),
  participantIds: z.array(z.string().uuid()),
  lastMessage: MessagePreviewSchema,
  unreadCount: z.number().int().min(0),
  lastMessageAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/**
 * POST /conversations — start a conversation with one or more other members
 * (the creator is added automatically). An optional `body` posts the first
 * message atomically. `title` is optional (1:1 threads derive their title from
 * the other participant in the UI).
 */
export const CreateConversationInput = z
  .object({
    participantIds: z.array(z.string().uuid()).min(1).max(50),
    title: z.string().min(1).max(120).optional(),
    body: z.string().min(1).max(5000).optional(),
  })
  .strict();
export type CreateConversation = z.infer<typeof CreateConversationInput>;

/** POST /conversations/:id/messages — send a message into a conversation. */
export const SendMessageInput = z
  .object({
    body: z.string().min(1).max(5000),
  })
  .strict();
export type SendMessage = z.infer<typeof SendMessageInput>;

/** GET /conversations — keyset pagination (by last_message_at, id). */
export const ListConversationsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type ListConversationsQueryDto = z.infer<typeof ListConversationsQuery>;

/** GET /conversations/:id/messages — keyset pagination (by created_at, id). */
export const ListMessagesQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type ListMessagesQueryDto = z.infer<typeof ListMessagesQuery>;
