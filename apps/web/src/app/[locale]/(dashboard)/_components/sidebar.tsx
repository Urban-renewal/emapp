'use client';

import {
  Bell,
  CheckSquare,
  FileSignature,
  FileSpreadsheet,
  FileText,
  HardHat,
  History,
  Home,
  Lock,
  Shield,
  StickyNote,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { NameDisplay } from '@/components/ui/name-display';
import { cn } from '@/lib/utils';

import { LogoutButton } from './logout-button';

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
    | 'tasks'
    | 'contractors'
    | 'notes'
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
  /** Display name in the user footer block. Wired through layout from
   *  the session profile; wrapped in `<NameDisplay>` for bidi safety. */
  userName: string;
  /** Same as `role` but typed as the BE role key; shown in the footer
   *  block translated under `nav.role.*`. */
  userRole: string;
  /** Tier discriminator passed to the logout button so it routes to
   *  the right Server Action + clears the right cookies. */
  tier: 'org' | 'provider';
}

/**
 * V11 A.S2 — Sidebar reskin to match the partner's navy AppShell
 * (`MEAPP_design/design_handoff/source/shell.jsx` Sidebar / navy
 * variant). 240px-wide full-height panel with:
 *   - Header: EM logo block + EMAPP wordmark + Hebrew tagline.
 *   - Nav: vertical list of route links with active-state visualisation
 *     (right-edge bar + bg highlight, per handoff `right: -10`).
 *   - Footer: avatar + name + role + LogoutButton.
 *
 * Closures preserved from prior versions:
 *  - §v9-H-4 (sidebar bare-`<a>` → `<Link>` so SPA navigation stays).
 *  - §v9-L-1 (disabled-item a11y → `<span aria-disabled>`, not focusable).
 *  - §D.17 role-gating (Members/Audit Manager-only; Provider tier-only).
 *  - §D.37 Provider tier separation (cosmetic FE; BE guard is authoritative).
 *
 * Active state — `usePathname()` strips the locale prefix (`/he/...` →
 * `/...`) and compares against the item's `href`. The home link
 * (`href: '/'`) needs an exact match; the rest are prefix matches so
 * deep paths (`/projects/[id]/buildings`) keep the parent nav highlighted.
 */
export function Sidebar({ role, userName, userRole, tier }: Props) {
  const t = useTranslations('nav');
  const locale = useLocale();
  const rawPath = usePathname() ?? '/';
  // Strip the `/he` or `/en` locale prefix so item.href can be compared
  // against the unprefixed app paths.
  const localePrefix = `/${locale}`;
  const path = rawPath.startsWith(localePrefix)
    ? rawPath.slice(localePrefix.length) || '/'
    : rawPath;

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
    { href: '/notifications', labelKey: 'notifications', icon: Bell, enabled: true },
    { href: '/tasks', labelKey: 'tasks', icon: CheckSquare, enabled: true },
    { href: '/contractors', labelKey: 'contractors', icon: HardHat, enabled: true },
    { href: '/notes', labelKey: 'notes', icon: StickyNote, enabled: true },
  ];

  if (role === 'manager') {
    items.push({ href: '/members', labelKey: 'members', icon: UserPlus, enabled: true });
    items.push({ href: '/audit', labelKey: 'audit', icon: History, enabled: true });
  }
  if (role === 'provider_admin') {
    items.push({ href: '/provider', labelKey: 'provider', icon: Shield, enabled: true });
  }

  function isActive(href: string): boolean {
    if (href === '/') return path === '/' || path === '';
    return path === href || path.startsWith(`${href}/`);
  }

  return (
    <aside
      className="sticky top-0 flex h-screen w-[240px] flex-shrink-0 flex-col"
      style={{
        background: 'var(--navy-900)',
        color: 'rgba(255,255,255,.85)',
        borderInlineStart: '1px solid rgba(255,255,255,.08)',
      }}
    >
      {/* Header: EM logo block + EMAPP wordmark + Hebrew tagline */}
      <div
        className="flex items-center gap-2.5 px-5 pb-[18px] pt-5"
        style={{ borderBottom: '1px solid rgba(255,255,255,.08)' }}
      >
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg font-bold tracking-wider"
          style={{ background: 'rgba(255,255,255,.12)', fontSize: 14 }}
          aria-hidden="true"
        >
          EM
        </div>
        <div>
          <div className="text-[15px] font-semibold text-white">EMAPP</div>
          <div className="text-[11px]" style={{ color: 'rgba(255,255,255,.6)' }}>
            {t('tagline')}
          </div>
        </div>
      </div>

      {/* Nav list */}
      <nav className="flex-1 overflow-auto p-2.5" aria-label={t('navLandmark')}>
        {items.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          const rowStyle = active
            ? { background: 'rgba(255,255,255,.08)', color: '#fff', fontWeight: 500 }
            : { background: 'transparent', color: 'rgba(255,255,255,.85)' };
          const rowClass = cn(
            'relative flex items-center gap-[11px] rounded-lg px-3 py-2.5 text-sm transition-colors',
            !active && 'hover:bg-white/[.04]',
            !item.enabled && 'cursor-not-allowed opacity-50',
          );

          if (!item.enabled) {
            return (
              <span
                key={item.href}
                aria-disabled
                className={rowClass}
                style={{ ...rowStyle, color: 'rgba(255,255,255,.4)' }}
              >
                <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                <span>{t(item.labelKey)}</span>
                <Lock className="ms-auto h-3 w-3" aria-hidden="true" />
              </span>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              className={rowClass}
              style={rowStyle}
              aria-current={active ? 'page' : undefined}
            >
              {/* Active edge bar — handoff places it `right: -10` (logical
               *  start under RTL). Use inset-inline-start so it flips
               *  correctly under LTR. */}
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 bottom-1.5 w-[3px] rounded-full bg-white"
                  style={{ insetInlineStart: -10 }}
                />
              )}
              <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
              <span>{t(item.labelKey)}</span>
            </Link>
          );
        })}
      </nav>

      {/* Footer: avatar + name + role + logout */}
      <div
        className="flex flex-col gap-2.5 p-3.5"
        style={{ borderTop: '1px solid rgba(255,255,255,.08)' }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="avatar"
            style={{
              background: 'rgba(255,255,255,.12)',
              color: '#fff',
            }}
            aria-hidden="true"
          >
            {initialsOf(userName)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-white">
              <NameDisplay name={userName} />
            </div>
            <div className="text-[11px]" style={{ color: 'rgba(255,255,255,.6)' }}>
              {t(`role.${userRole as 'manager' | 'agent' | 'viewer' | 'provider_admin'}`)}
            </div>
          </div>
        </div>
        <LogoutButton tier={tier} />
      </div>
    </aside>
  );
}

/**
 * 1-2 char initial helper — Hebrew names take the first letter of the
 * first two whitespace-separated tokens; single-word names use the
 * first 2 chars. Wraps `<NameDisplay>` not needed here because the
 * output is purely letters (no bidi-spoofable content).
 */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0] ?? '') + (parts[1]![0] ?? '');
  return name.slice(0, 2);
}
