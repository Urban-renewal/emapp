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

// X-S2 (V13) — external-share party taxonomy (migration 0077). The KIND of
// external party a share grants access to. Each value has a server-side preset
// CEILING (the widest scope+perms it may ever receive) defined alongside the
// schema in `external-share.ts`; the service can only NARROW from the ceiling,
// never widen. ADDITIVE: new party types append here (+ a ceiling entry).
export const externalSharePartyTypeEnum = pgEnum('external_share_party_type', [
  'developer',
  'tenant_lawyer',
  'developer_lawyer',
  'bank',
  'supervisor',
  'appraiser',
  'surveyor',
  'committee',
  'special_admin',
]);

// X-S2 (V13) — external-share scope granularity (migration 0077). What the
// `scope_ids` uuid[] points AT: whole projects, specific buildings, or specific
// apartments. The preset ceiling per party_type also pins the WIDEST scope_type
// allowed (e.g. an appraiser may be apartment-scoped only, never project-wide).
export const externalShareScopeTypeEnum = pgEnum('external_share_scope_type', [
  'project',
  'building',
  'apartment',
]);
