'use client';

import { FileSpreadsheet, FileText, Home, Lock, Users } from 'lucide-react';
import Link from 'next/link';
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
 * Manager-tier sidebar.
 *
 * Closes §v9-H-4 (sidebar bare-<a> → <Link>) + §v9-L-1 (disabled-item
 * a11y). Enabled items render as `<Link>` so navigation is SPA-style
 * (no full document load, no Heebo font re-fetch, TanStack cache
 * preserved); disabled items render as `<span aria-disabled>` so
 * they are NOT in the tab order and screen readers announce them as
 * unavailable rather than as fake links.
 */
export function Sidebar() {
  const t = useTranslations('nav');

  const items: NavItem[] = [
    { href: '/', labelKey: 'home', icon: Home, enabled: true },
    { href: '/projects', labelKey: 'projects', icon: FileText, enabled: true },
    { href: '/owners', labelKey: 'owners', icon: Users, enabled: true },
    { href: '/imports', labelKey: 'imports', icon: FileSpreadsheet, enabled: false },
    { href: '/documents', labelKey: 'documents', icon: FileText, enabled: true },
  ];

  return (
    <nav className="flex h-full w-56 flex-col gap-1 border-s bg-muted/30 p-4">
      {items.map((item) => {
        const Icon = item.icon;
        const rowClass = cn(
          'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          item.enabled
            ? 'text-foreground hover:bg-muted'
            : 'cursor-not-allowed text-muted-foreground/60',
        );
        if (!item.enabled) {
          return (
            <span key={item.href} aria-disabled className={rowClass}>
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{t(item.labelKey)}</span>
              <Lock className="ms-auto h-3 w-3" aria-hidden="true" />
            </span>
          );
        }
        return (
          <Link key={item.href} href={item.href} className={rowClass}>
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span>{t(item.labelKey)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
