/**
 * StatusBadge — semantic-color → tailwind-class mapping for status pill
 * rendering.
 *
 * §SOLID-M3 closure — was duplicated 8 times as inline
 * `STATUS_BADGE: Record<'gray' | 'amber' | 'emerald' | 'red', string>`
 * across projects/owners/imports/signature-requests/apartments page
 * files. Centralised here. Adding a new colour or tweaking the palette
 * is now ONE file, not 8.
 *
 * The semantic colour comes from the entity's ViewModel
 * (`statusColor`); the badge owns the tailwind classes that realise it.
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type StatusColor = 'gray' | 'amber' | 'emerald' | 'red';

const STATUS_BADGE_CLASS: Record<StatusColor, string> = {
  gray: 'bg-gray-100 text-gray-700',
  amber: 'bg-amber-100 text-amber-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  red: 'bg-red-100 text-red-800',
};

export interface StatusBadgeProps {
  color: StatusColor;
  children: ReactNode;
  className?: string;
}

export function StatusBadge({ color, children, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        STATUS_BADGE_CLASS[color],
        className,
      )}
    >
      {children}
    </span>
  );
}

// Exported for the rare consumer that needs the raw class (e.g. building
// a complex cell layout). Prefer the <StatusBadge> component.
export { STATUS_BADGE_CLASS };
