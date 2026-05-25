'use client';

import {
  Bell,
  FileSignature,
  FileSpreadsheet,
  FileText,
  History,
  Home,
  Lock,
  Shield,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  /** Key under the `nav` next-intl namespace. */
  labelKey:
    | 'home'
    | 'projects'
    | 'owners'
    | 'imports'
    | 'documents'
    | 'signatureRequests'
    | 'members'
    | 'notifications'
    | 'audit'
    | 'provider';
  icon: typeof Home;
  enabled: boolean;
}

interface Props {
  /** User role from `getMe()` — server-side loaded. Used to show the
   *  provider nav item ONLY for `provider_admin`. Org-tier users
   *  never see (or know about) the existence of the provider subtree.
   *  This is FE-side cosmetics; the BE's ProviderAuthGuard enforces
   *  the actual tier separation. */
  role?: string;
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
export function Sidebar({ role }: Props) {
  const t = useTranslations('nav');

  const items: NavItem[] = [
    { href: '/', labelKey: 'home', icon: Home, enabled: true },
    { href: '/projects', labelKey: 'projects', icon: FileText, enabled: true },
    { href: '/owners', labelKey: 'owners', icon: Users, enabled: true },
    { href: '/imports', labelKey: 'imports', icon: FileSpreadsheet, enabled: true },
    { href: '/documents', labelKey: 'documents', icon: FileText, enabled: true },
    {
      href: '/signature-requests',
      labelKey: 'signatureRequests',
      icon: FileSignature,
      enabled: true,
    },
    // Notifications: self-scoped by RLS — any org role sees their own.
    { href: '/notifications', labelKey: 'notifications', icon: Bell, enabled: true },
  ];

  // §D.17 — Members admin is Manager-only (policy.ts:71). The BE's
  // AuthorizationGuard returns 403 for non-Manager calls regardless,
  // but cosmetically hiding the link keeps Agents / Viewers from
  // clicking into a list that can only show them an error. Phase 4c S1.
  if (role === 'manager') {
    items.push({ href: '/members', labelKey: 'members', icon: UserPlus, enabled: true });
    // §D.17 — Audit is Manager-only (policy.ts:68 + service role check
    // at audit-read.service.ts:28). Same cosmetic-gate rationale as
    // Members. Phase 4c S4.
    items.push({ href: '/audit', labelKey: 'audit', icon: History, enabled: true });
  }

  // §D.37 — Provider Admin nav item appears ONLY for the provider tier.
  // Org-tier roles (manager/agent/viewer/contractor/tenant) never see
  // it. The BE's ProviderAuthGuard enforces tier separation at the API
  // level; this is the FE-side cosmetic equivalent so non-providers
  // never see a link they cannot use.
  if (role === 'provider_admin') {
    items.push({ href: '/provider', labelKey: 'provider', icon: Shield, enabled: true });
  }

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
