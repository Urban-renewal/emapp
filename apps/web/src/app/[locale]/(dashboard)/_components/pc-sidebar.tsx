'use client';

import {
  BarChart3,
  Building,
  CheckSquare,
  Database,
  HeartPulse,
  History,
  Lock,
  Mail,
  Plug,
  Receipt,
  Settings,
  Tag,
  UserCheck,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';

import { NameDisplay } from '@/components/ui/name-display';
import { cn } from '@/lib/utils';

import { LogoutButton } from './logout-button';

/**
 * V11 A.S13 — Platform Console sidebar (PCSidebar) per
 * `MEAPP_design/org-admin.jsx` PCSidebar (lines 32-109).
 *
 * Provider-tier-specific sidebar. Replaces the org-tier Sidebar for
 * routes under `/provider/*` (the parent dashboard/layout.tsx branches
 * on `session.tier`). Visual identity:
 *   - 248px navy panel
 *   - Header: gradient EM logo + "EMAPP" + "קונסולת פלטפורמה" tagline
 *   - Environment chip ("סביבת ייצור · prod-il-1") with pulsing green
 *     dot (cosmetic — env detection is server-side concern; this is
 *     a static "you are operating in the Platform Console" reminder)
 *   - 4 nav groups (סקירה / מסחר / תפעול ואבטחה / ניהול פלטפורמה)
 *     with uppercase tracked-out group headings.
 *   - 13 nav items — 4 wired (overview / orgs / health / audit) and
 *     9 placeholders that surface the planned surface area but are
 *     `aria-disabled` until the BE slice lands.
 *   - Footer: avatar + name + role + LogoutButton (provider tier).
 *
 * Wired vs stubbed mapping (org-admin.jsx PC_NAV ↔ our routes):
 *
 * | id              | partner label             | route                     | status |
 * |-----------------|---------------------------|---------------------------|--------|
 * | overview        | דשבורד פלטפורמה            | /provider                 | wired  |
 * | orgs            | ארגונים                    | /provider/tenants         | wired  |
 * | users           | משתמשים                    | /provider/tenants?view=users | wired |
 * | plans           | תוכניות ומחירון            | —                         | stub   |
 * | billing         | חיובים ומנויים             | —                         | stub   |
 * | support         | תמיכה ופניות               | —                         | stub   |
 * | roles           | תפקידים והרשאות            | —                         | stub   |
 * | integrations    | אינטגרציות                | —                         | stub   |
 * | health          | בריאות מערכת              | /provider/system-health   | wired  |
 * | backups         | גיבויים ושחזור            | /provider/backups         | wired  |
 * | audit           | יומן פעילות                | /provider/audit           | wired  |
 * | selfAudit       | הפעילות שלי                | /provider/audit/self      | wired  |
 * | staff           | צוות EMAPP                | —                         | stub   |
 * | settings        | הגדרות פלטפורמה            | —                         | stub   |
 *
 * Stub items render as `<span aria-disabled>` (not `<button>`) so they
 * are non-focusable per §v9-L-1 — same pattern as the org Sidebar.
 */
type GroupKey = 'overview' | 'biz' | 'ops' | 'admin';

type ItemKey =
  | 'overview'
  | 'orgs'
  | 'users'
  | 'plans'
  | 'billing'
  | 'support'
  | 'roles'
  | 'integrations'
  | 'health'
  | 'backups'
  | 'audit'
  | 'selfAudit'
  | 'staff'
  | 'settings';

interface NavItem {
  id: ItemKey;
  group: GroupKey;
  /** Set to a route ('/provider/...') for wired items. `null` = stub. */
  href: string | null;
  /** Optional query string (no leading '?') appended to the Link href only —
   *  NOT used for active-state matching (which is path-based). */
  query?: string;
  icon: typeof BarChart3;
}

const ITEMS: NavItem[] = [
  // overview
  { id: 'overview', group: 'overview', href: '/provider', icon: BarChart3 },
  { id: 'orgs', group: 'overview', href: '/provider/tenants', icon: Building },
  // P4 — org users management is per-org: the nav lands on the org list
  // (?view=users) where the operator picks a tenant, then drills into its
  // masked members via /provider/tenants/:id/users.
  { id: 'users', group: 'overview', href: '/provider/tenants', query: 'view=users', icon: Users },
  // biz
  { id: 'plans', group: 'biz', href: null, icon: Tag },
  { id: 'billing', group: 'biz', href: null, icon: Receipt },
  { id: 'support', group: 'biz', href: null, icon: Mail },
  // ops
  { id: 'roles', group: 'ops', href: null, icon: CheckSquare },
  { id: 'integrations', group: 'ops', href: null, icon: Plug },
  { id: 'health', group: 'ops', href: '/provider/system-health', icon: HeartPulse },
  { id: 'backups', group: 'ops', href: '/provider/backups', icon: Database },
  { id: 'audit', group: 'ops', href: '/provider/audit', icon: History },
  { id: 'selfAudit', group: 'ops', href: '/provider/audit/self', icon: UserCheck },
  // admin
  { id: 'staff', group: 'admin', href: null, icon: Users },
  { id: 'settings', group: 'admin', href: null, icon: Settings },
];

const GROUP_ORDER: GroupKey[] = ['overview', 'biz', 'ops', 'admin'];

interface Props {
  userName: string;
  /** Always 'provider_admin' in MVP; passed through for future-proofing. */
  userRole: string;
}

export function PCSidebar({ userName, userRole }: Props) {
  const t = useTranslations('provider.pcNav');
  const tCommon = useTranslations('nav');
  const locale = useLocale();
  const rawPath = usePathname() ?? '/';
  const localePrefix = `/${locale}`;
  const path = rawPath.startsWith(localePrefix)
    ? rawPath.slice(localePrefix.length) || '/'
    : rawPath;

  // The single best-matching wired href for the current path. Picking the
  // LONGEST prefix match prevents a parent item (e.g. /provider/audit) from
  // also lighting up when a more specific child (/provider/audit/self) is
  // the real active route.
  const activeHref = useMemo(() => {
    let best: string | null = null;
    for (const item of ITEMS) {
      if (item.href === null) continue;
      const matches =
        item.href === '/provider'
          ? path === '/provider'
          : path === item.href || path.startsWith(`${item.href}/`);
      if (matches && (best === null || item.href.length > best.length)) {
        best = item.href;
      }
    }
    return best;
  }, [path]);

  function isActive(href: string): boolean {
    return href === activeHref;
  }

  return (
    <aside
      className="sticky top-0 flex h-screen w-[248px] flex-shrink-0 flex-col"
      style={{
        background: 'var(--navy-900)',
        color: 'rgba(255,255,255,.85)',
        borderInlineStart: '1px solid rgba(255,255,255,.08)',
      }}
    >
      {/* Header: gradient EM logo + console wordmark + env chip */}
      <div
        className="flex flex-col gap-3.5 px-[18px] pb-4 pt-[18px]"
        style={{ borderBottom: '1px solid rgba(255,255,255,.08)' }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-[34px] w-[34px] items-center justify-center rounded-lg font-bold text-white"
            style={{
              background: 'linear-gradient(135deg, oklch(0.62 0.16 230), oklch(0.52 0.18 250))',
              fontSize: 13,
              letterSpacing: '.02em',
            }}
            aria-hidden="true"
          >
            EM
          </div>
          <div>
            <div className="text-[14.5px] font-semibold leading-tight text-white">EMAPP</div>
            <div className="text-[11px]" style={{ color: 'rgba(255,255,255,.55)' }}>
              {t('consoleTagline')}
            </div>
          </div>
        </div>

        <div
          className="flex items-center gap-2 rounded-lg"
          style={{
            padding: '7px 10px',
            background: 'rgba(255,255,255,.06)',
            border: '1px solid rgba(255,255,255,.08)',
          }}
        >
          <span
            className="inline-block h-[7px] w-[7px] rounded-full"
            style={{
              background: 'oklch(0.74 0.18 145)',
              boxShadow: '0 0 8px oklch(0.74 0.18 145 / 0.6)',
            }}
            aria-hidden="true"
          />
          <span className="text-[11.5px]" style={{ color: 'rgba(255,255,255,.85)' }}>
            {t('envChip')}
          </span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-auto p-2.5" aria-label={tCommon('navLandmark')}>
        {GROUP_ORDER.map((groupKey, gi) => (
          <div key={groupKey} style={{ marginTop: gi === 0 ? 0 : 14 }}>
            <div
              className="font-semibold uppercase"
              style={{
                padding: '6px 12px 6px',
                fontSize: 10.5,
                letterSpacing: '.08em',
                color: 'rgba(255,255,255,.4)',
              }}
            >
              {t(`group.${groupKey}`)}
            </div>

            {ITEMS.filter((item) => item.group === groupKey).map((item) => {
              const Icon = item.icon;
              const wired = item.href !== null;
              const active = wired && isActive(item.href!);

              const rowClass = cn(
                'relative flex w-full items-center gap-[11px] rounded-lg px-3 py-2 text-[13.5px] transition-colors',
                wired && !active && 'hover:bg-white/[.05]',
                !wired && 'cursor-not-allowed opacity-50',
              );

              const rowStyle: React.CSSProperties = active
                ? { background: 'rgba(255,255,255,.10)', color: '#fff', fontWeight: 500 }
                : wired
                  ? { background: 'transparent', color: 'rgba(255,255,255,.78)' }
                  : { background: 'transparent', color: 'rgba(255,255,255,.45)' };

              if (!wired) {
                return (
                  <span
                    key={item.id}
                    aria-disabled
                    className={rowClass}
                    style={rowStyle}
                    title={t('stubHint')}
                  >
                    <Icon
                      className="h-[17px] w-[17px]"
                      aria-hidden="true"
                      style={{ color: 'rgba(255,255,255,.45)' }}
                    />
                    <span>{t(`item.${item.id}`)}</span>
                    <Lock
                      className="ms-auto h-3 w-3"
                      aria-hidden="true"
                      style={{ color: 'rgba(255,255,255,.4)' }}
                    />
                  </span>
                );
              }

              return (
                <Link
                  key={item.id}
                  href={(item.query ? `${item.href}?${item.query}` : item.href) as '/provider'}
                  className={rowClass}
                  style={rowStyle}
                  aria-current={active ? 'page' : undefined}
                >
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute top-1.5 bottom-1.5 w-[3px] rounded-full bg-white"
                      style={{ insetInlineStart: -10 }}
                    />
                  )}
                  <Icon
                    className="h-[17px] w-[17px]"
                    aria-hidden="true"
                    style={{ color: active ? '#fff' : 'rgba(255,255,255,.55)' }}
                  />
                  <span>{t(`item.${item.id}`)}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div
        className="flex flex-col gap-2.5 p-3.5"
        style={{ borderTop: '1px solid rgba(255,255,255,.08)' }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="avatar"
            style={{ background: 'rgba(255,255,255,.12)', color: '#fff' }}
            aria-hidden="true"
          >
            {initialsOf(userName)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-white">
              <NameDisplay name={userName} />
            </div>
            <div className="text-[11px]" style={{ color: 'rgba(255,255,255,.55)' }}>
              {tCommon(`role.${userRole as 'provider_admin'}`)}
            </div>
          </div>
        </div>
        <LogoutButton tier="provider" />
      </div>
    </aside>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0] ?? '') + (parts[1]![0] ?? '');
  return name.slice(0, 2);
}
