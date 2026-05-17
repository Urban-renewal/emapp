import { pgEnum } from 'drizzle-orm/pg-core';

export const projectTypeEnum = pgEnum('project_type', ['tama38_1', 'tama38_2', 'pinui_binui']);

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
]);
