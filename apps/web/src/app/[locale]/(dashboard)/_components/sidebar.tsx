'use client';

import {
  Bell,
  CheckSquare,
  ChevronDown,
  FileSignature,
  FileSpreadsheet,
  FileText,
  HardHat,
  History,
  Home,
  Lock,
  MessageSquare,
  Settings,
  StickyNote,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

import { NameDisplay } from '@/components/ui/name-display';
import { useHasPermission } from '@/hooks/use-permissions';
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
    | 'messages'
    | 'audit'
    | 'settings'
    | 'provider'
    | 'sectionTools';
  icon: typeof Home;
  enabled: boolean;
}

interface Props {
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
 * E2 Wave-1 IA-S2 — calm the nav from 14 flat items to 5 PRIMARY
 * (always visible: ראשי · פרויקטים · בעלי דירות · בקשות חתימה · מסמכים —
 * the daily signature-collection workflow) plus a collapsible SECONDARY
 * group ("ניהול וכלים") holding the remaining management/tools routes
 * (ייבוא · קבלנים · הערות · הודעות · משימות · התראות · חברי ארגון ·
 * יומן ביקורת · הגדרות). NOTHING is removed — every route stays
 * reachable; the secondary group is collapsed-but-present. The grouping
 * is presentation ONLY: permission gating (Owners/Members/Audit/Settings)
 * is unchanged, so this never widens WHO sees WHAT. The disclosure is an
 * accessible button (`aria-expanded` + keyboard) and auto-expands when a
 * secondary route is the active page so its highlight is never hidden.
 * Animation rides `--motion-duration-fast`, which the globals.css
 * `prefers-reduced-motion` guard zeroes — instant for reduced-motion.
 *
 * Closures preserved from prior versions:
 *  - §v9-H-4 (sidebar bare-`<a>` → `<Link>` so SPA navigation stays).
 *  - §v9-L-1 (disabled-item a11y → `<span aria-disabled>`, not focusable).
 *  - IAM slice 5b — Members/Audit/Settings nav gate on the actor's effective
 *    PERMISSIONS (`members.read` / `audit.read` / `org.settings.read`) from
 *    `/me`, not the legacy `role === 'manager'` string. (Supersedes §D.17
 *    role-gating here; the BE guard stays authoritative.)
 *  - §D.37 Provider tier separation (cosmetic FE; BE guard is authoritative).
 *
 * Active state — `usePathname()` strips the locale prefix (`/he/...` →
 * `/...`) and compares against the item's `href`. The home link
 * (`href: '/'`) needs an exact match; the rest are prefix matches so
 * deep paths (`/projects/[id]/buildings`) keep the parent nav highlighted.
 */
export function Sidebar({ userName, userRole, tier }: Props) {
  const t = useTranslations('nav');
  const locale = useLocale();
  // IAM slice 5b — nav items gate on the actor's effective PERMISSIONS
  // (from `/me`), not the legacy `role === 'manager'` string. Members/Audit/
  // Settings each appear iff the actor holds the matching read permission.
  // UX only; the BE guards each route regardless (defense in depth).
  const canReadMembers = useHasPermission('members.read');
  const canReadAudit = useHasPermission('audit.read');
  const canReadSettings = useHasPermission('org.settings.read');
  // P4 #11 — the Owners nav item is capability-gated: an agent WITHOUT the
  // `view_owners` capability does NOT hold `owners.read` in their effective set
  // (BE `agent-effective-permissions` filters `owners.read` on `view_owners`),
  // so clicking Owners would 403/404. Gate the item on the effective read
  // permission — correct for every role (managers/viewers hold `owners.read`;
  // an agent holds it iff view_owners is ON) and any future capability, with
  // NO `role === 'agent'` math. UX only; the BE guard stays authoritative.
  const canReadOwners = useHasPermission('owners.read');
  const rawPath = usePathname() ?? '/';
  // Strip the `/he` or `/en` locale prefix so item.href can be compared
  // against the unprefixed app paths.
  const localePrefix = `/${locale}`;
  const path = rawPath.startsWith(localePrefix)
    ? rawPath.slice(localePrefix.length) || '/'
    : rawPath;

  // PRIMARY (5, always visible) — the daily signature-collection workflow.
  // Owners is gated on `owners.read` (see canReadOwners above); an agent
  // without view_owners never holds it, so the link is hidden rather than
  // rendering a 403/404 dead-link. Gating is unchanged from the flat nav —
  // only the grouping moved.
  const primaryItems: NavItem[] = [
    { href: '/', labelKey: 'home', icon: Home, enabled: true },
    { href: '/projects', labelKey: 'projects', icon: FileText, enabled: true },
    ...(canReadOwners
      ? [{ href: '/owners', labelKey: 'owners', icon: Users, enabled: true } as NavItem]
      : []),
    {
      href: '/signature-requests',
      labelKey: 'signatureRequests',
      icon: FileSignature,
      enabled: true,
    },
    { href: '/documents', labelKey: 'documents', icon: FileText, enabled: true },
  ];

  // SECONDARY (collapsible "ניהול וכלים") — management + tools. Every route
  // here stays reachable; the group is collapsed-but-present, not deleted.
  // Members/Audit/Settings keep their effective-permission gate (unchanged),
  // so the grouping never widens visibility.
  const secondaryItems: NavItem[] = [
    { href: '/imports', labelKey: 'imports', icon: FileSpreadsheet, enabled: true },
    { href: '/contractors', labelKey: 'contractors', icon: HardHat, enabled: true },
    { href: '/notes', labelKey: 'notes', icon: StickyNote, enabled: true },
    { href: '/messages', labelKey: 'messages', icon: MessageSquare, enabled: true },
    { href: '/tasks', labelKey: 'tasks', icon: CheckSquare, enabled: true },
    { href: '/notifications', labelKey: 'notifications', icon: Bell, enabled: true },
  ];

  if (canReadMembers) {
    secondaryItems.push({ href: '/members', labelKey: 'members', icon: UserPlus, enabled: true });
  }
  if (canReadAudit) {
    secondaryItems.push({ href: '/audit', labelKey: 'audit', icon: History, enabled: true });
  }
  if (canReadSettings) {
    secondaryItems.push({
      href: '/settings',
      labelKey: 'settings',
      icon: Settings,
      enabled: true,
    });
  }
  // V11 A.S13: provider_admin no longer mounted on the org Sidebar — the
  // dashboard layout now branches to the dedicated PCSidebar for the
  // provider tier so the visual + nav structure matches the partner
  // Platform Console (13 nav items, 4 groups).

  function isActive(href: string): boolean {
    if (href === '/') return path === '/' || path === '';
    return path === href || path.startsWith(`${href}/`);
  }

  /** Render a single nav row (Link, or a disabled `<span>` for locked items).
   *  Shared by the primary list and the collapsible secondary group so the
   *  active-state visualisation, a11y, and styling stay identical. */
  function renderRow(item: NavItem) {
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
        {/* Active edge bar — handoff places it `right: -10` (logical start
         *  under RTL). Use inset-inline-start so it flips correctly under LTR. */}
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
  }

  // Auto-expand the secondary group when the active page lives inside it, so
  // the highlight is never hidden behind a collapsed disclosure. Default
  // collapsed otherwise (the calm primary-5 surface). State is initialised
  // once from the path; the user can then toggle it freely.
  const secondaryHasActive = secondaryItems.some((item) => isActive(item.href));
  const [toolsOpen, setToolsOpen] = useState(secondaryHasActive);

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

      {/* Nav list — 5 primary rows + a collapsible "ניהול וכלים" group. */}
      <nav className="flex-1 overflow-auto p-2.5" aria-label={t('navLandmark')}>
        {primaryItems.map((item) => renderRow(item))}

        {/* Secondary group — accessible disclosure. The button toggles a
         *  region holding every management/tools route. All routes stay
         *  reachable; collapsed is the default calm state (auto-open when a
         *  child is the active page). */}
        <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--sidebar-border)' }}>
          <button
            type="button"
            onClick={() => setToolsOpen((v) => !v)}
            aria-expanded={toolsOpen}
            aria-controls="nav-tools-group"
            className={cn(
              'flex w-full items-center gap-[11px] rounded-lg px-3 py-2.5 text-sm transition-colors',
              'hover:bg-white/[.04]',
            )}
            style={{ background: 'transparent', color: 'var(--sidebar-muted)' }}
          >
            <span className="text-[11px] font-semibold uppercase tracking-wider">
              {t('sectionTools')}
            </span>
            <ChevronDown
              className={cn(
                'ms-auto h-4 w-4 transition-transform motion-reduce:transition-none',
                toolsOpen && 'rotate-180',
              )}
              style={{ transitionDuration: 'var(--motion-duration-fast)' }}
              aria-hidden="true"
            />
          </button>
          {toolsOpen && (
            <div id="nav-tools-group" role="group" aria-label={t('sectionTools')}>
              {secondaryItems.map((item) => renderRow(item))}
            </div>
          )}
        </div>
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
