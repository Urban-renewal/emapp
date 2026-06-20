import { pgEnum } from 'drizzle-orm/pg-core';

// 'other' is an ADDITIVE forward-compat value (migration 0062) so FUTURE
// renewal tracks (e.g. the post-2026 תמ"א-sunset successor / חלופת שקד) can be
// represented without editing the three legacy values. Pair it with the
// nullable `projects.type_label` free-text column for the human track name.
// NOTE: this is the project TYPE enum; the LOCKED D.18 `project_status` enum
// below is intentionally NOT extended.
export const projectTypeEnum = pgEnum('project_type', [
  'tama38_1',
  'tama38_2',
  'pinui_binui',
  'other',
]);

// D.18 (LAW): locked status set.
export const projectStatusEnum = pgEnum('project_status', [
  'planning',
  'gathering_signatures',
  'approved',
  'in_construction',
  'completed',
  'cancelled',
]);

export const apartmentStatusEnum = pgEnum('apartment_status', [
  'pending',
  'contacted',
  'meeting',
  'signed',
  'refused',
  'unreachable',
]);

export const userRoleEnum = pgEnum('user_role', ['manager', 'agent', 'viewer']);

export const taskStatusEnum = pgEnum('task_status', [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);

export const notificationTypeEnum = pgEnum('notification_type', [
  'task_assigned',
  'apartment_status_changed',
  'document_uploaded',
  'signature_received',
  'note_added',
  'share_revoked',
  'mention',
  // Team messaging (migration 0076) — a new message arrived in a conversation.
  'message_received',
]);

// DH1 (migration 0077) — the closed document-taxonomy SCOPE enum. A document
// hangs off exactly one scope: the org as a whole, a project, an apartment, or
// (new) a single owner. Paired with `documents.doc_scope_id` (the typed target
// id; NULL only for 'org') under a DB CHECK that keeps the two consistent. This
// SUPERSEDES the ad-hoc project_id/apartment_id nullable columns as the
// canonical scope concept; those columns are retained for back-compat.
export const docScopeEnum = pgEnum('doc_scope', ['org', 'project', 'apartment', 'owner']);
