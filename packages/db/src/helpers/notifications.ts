import type { NewNotification, NotificationType } from '../schema/collaboration';

export interface NotificationPayload {
  orgId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

export function buildNotification(payload: NotificationPayload): NewNotification {
  return {
    orgId: payload.orgId,
    userId: payload.userId,
    type: payload.type,
    title: payload.title,
    body: payload.body ?? null,
    link: payload.link ?? null,
    metadata: payload.metadata ?? {},
  };
}

export function taskAssignedNotification(params: {
  orgId: string;
  userId: string;
  taskTitle: string;
  taskId: string;
}): NewNotification {
  return buildNotification({
    orgId: params.orgId,
    userId: params.userId,
    type: 'task_assigned',
    title: `הוקצתה לך משימה: ${params.taskTitle}`,
    link: `/tasks/${params.taskId}`,
    metadata: { taskId: params.taskId },
  });
}

export function apartmentStatusChangedNotification(params: {
  orgId: string;
  userId: string;
  apartmentNumber: string;
  newStatus: string;
  apartmentId: string;
}): NewNotification {
  return buildNotification({
    orgId: params.orgId,
    userId: params.userId,
    type: 'apartment_status_changed',
    title: `דירה ${params.apartmentNumber} עברה לסטטוס: ${params.newStatus}`,
    link: `/apartments/${params.apartmentId}`,
    metadata: { apartmentId: params.apartmentId, newStatus: params.newStatus },
  });
}

export function signatureReceivedNotification(params: {
  orgId: string;
  userId: string;
  apartmentNumber: string;
  projectId: string;
  apartmentId: string;
}): NewNotification {
  return buildNotification({
    orgId: params.orgId,
    userId: params.userId,
    type: 'signature_received',
    title: `התקבלה חתימה מדירה ${params.apartmentNumber}`,
    link: `/projects/${params.projectId}/apartments/${params.apartmentId}`,
    metadata: { projectId: params.projectId, apartmentId: params.apartmentId },
  });
}
