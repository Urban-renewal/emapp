'use client';

import type { NotificationType } from '@emapp/shared-types';
import {
  AtSign,
  Bell,
  CheckSquare,
  FileSignature,
  FileText,
  Home,
  MessageSquare,
  ShieldOff,
  StickyNote,
} from 'lucide-react';

/**
 * V11 A.S11 — per-NotificationType icon + tone mapping.
 *
 * Partner `NotificationsPanel` (shell.jsx line 179) and
 * `ManagerNotificationsPage` (shell.jsx line 395) render each
 * notification with a 32-38px tone-tinted square holding an icon.
 * Our wire only carries the `type` enum (no `icon` / `tone`), so the
 * mapping lives here — exhaustive over the locked `NotificationTypeEnum`
 * (packages/shared-types/src/notification.ts).
 *
 * Shared between bell popover + full-page list to keep the visual
 * vocabulary consistent.
 */

type Tone = 'success' | 'warning' | 'navy' | 'danger';

interface ToneTokens {
  bg: string;
  fg: string;
}

const TONE_TOKENS: Record<Tone, ToneTokens> = {
  success: { bg: 'var(--success-50)', fg: 'var(--success-700)' },
  warning: { bg: 'var(--warning-50)', fg: 'var(--warning-700)' },
  navy: { bg: 'var(--navy-50)', fg: 'var(--navy-700)' },
  danger: { bg: 'var(--danger-50)', fg: 'var(--danger-600)' },
};

type IconCmp = typeof Bell;

interface NotificationVisual {
  icon: IconCmp;
  tone: Tone;
}

const TYPE_TO_VISUAL: Record<NotificationType, NotificationVisual> = {
  task_assigned: { icon: CheckSquare, tone: 'warning' },
  apartment_status_changed: { icon: Home, tone: 'navy' },
  document_uploaded: { icon: FileText, tone: 'navy' },
  signature_received: { icon: FileSignature, tone: 'success' },
  note_added: { icon: StickyNote, tone: 'navy' },
  share_revoked: { icon: ShieldOff, tone: 'danger' },
  mention: { icon: AtSign, tone: 'navy' },
  message_received: { icon: MessageSquare, tone: 'navy' },
};

interface Props {
  type: NotificationType;
  /** 32px (bell popover) or 38px (page list). Default: 32. */
  size?: 32 | 38;
}

export function NotificationIconTile({ type, size = 32 }: Props) {
  const visual = TYPE_TO_VISUAL[type] ?? { icon: Bell, tone: 'navy' as const };
  const tokens = TONE_TOKENS[visual.tone];
  const Icon = visual.icon;
  const iconSize = size === 38 ? 17 : 15;
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg"
      style={{
        width: size,
        height: size,
        background: tokens.bg,
        color: tokens.fg,
        borderRadius: size === 38 ? 10 : 8,
      }}
      aria-hidden="true"
    >
      <Icon style={{ width: iconSize, height: iconSize }} aria-hidden="true" />
    </div>
  );
}
