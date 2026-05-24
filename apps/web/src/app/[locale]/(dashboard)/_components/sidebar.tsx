'use client';

import { FileSpreadsheet, FileText, Home, Lock, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  /** Key under the `nav` next-intl namespace. */
  labelKey: 'home' | 'projects' | 'owners' | 'imports' | 'documents';
  icon: typeof Home;
  enabled: boolean;
}

/**
 * Manager-tier sidebar. Phase 4a S1 ships with Home active and every
 * other route disabled (they light up slice-by-slice in S2-S7). Disabled
 * items are still rendered with a lock icon so the user has visibility
 * into what's coming.
 */
export function Sidebar() {
  const t = useTranslations('nav');

  const items: NavItem[] = [
    { href: '/', labelKey: 'home', icon: Home, enabled: true },
    { href: '/projects', labelKey: 'projects', icon: FileText, enabled: false },
    { href: '/owners', labelKey: 'owners', icon: Users, enabled: false },
    { href: '/imports', labelKey: 'imports', icon: FileSpreadsheet, enabled: false },
    { href: '/documents', labelKey: 'documents', icon: FileText, enabled: false },
  ];

  return (
    <nav className="flex h-full w-56 flex-col gap-1 border-s bg-muted/30 p-4">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <a
            key={item.href}
            href={item.enabled ? item.href : undefined}
            aria-disabled={!item.enabled}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              item.enabled
                ? 'text-foreground hover:bg-muted'
                : 'cursor-not-allowed text-muted-foreground/60',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span>{t(item.labelKey)}</span>
            {!item.enabled && <Lock className="ms-auto h-3 w-3" aria-hidden="true" />}
          </a>
        );
      })}
    </nav>
  );
}
