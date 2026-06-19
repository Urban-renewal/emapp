/**
 * StatusBadge — semantic-INTENT → tailwind-class mapping for status pill
 * rendering.
 *
 * §SOLID-M3 closure — was duplicated 8 times as inline
 * `STATUS_BADGE: Record<'gray' | 'amber' | 'emerald' | 'red', string>`
 * across projects/owners/imports/signature-requests/apartments page
 * files. Centralised here. Adding a new intent or tweaking the palette
 * is now ONE file, not 8.
 *
 * E2.0b — re-homed onto the EMAPP semantic status tokens. The pill now
 * renders via the token-backed `.badge` / `.badge-{intent}` component
 * classes in `globals.css` (`--status-{intent}-bg`/`-fg`), NOT Tailwind's
 * default palette (the emerald/red/amber 100/700 shades it used before),
 * so a token re-skin / per-org branding flows through automatically.
 *
 * The semantic intent comes from the entity's ViewModel (`intent`); the
 * badge owns the component classes that realise it.
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type Intent = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const STATUS_BADGE_CLASS: Record<Intent, string> = {
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
  info: 'badge-info',
  neutral: 'badge-neutral',
};

export interface StatusBadgeProps {
  intent: Intent;
  children: ReactNode;
  className?: string;
}

export function StatusBadge({ intent, children, className }: StatusBadgeProps) {
  return <span className={cn('badge', STATUS_BADGE_CLASS[intent], className)}>{children}</span>;
}

// Exported for the rare consumer that needs the raw class (e.g. building
// a complex cell layout). Prefer the <StatusBadge> component.
export { STATUS_BADGE_CLASS };
