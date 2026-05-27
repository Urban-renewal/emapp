'use client';

import { Mail, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useMemberList } from '@/hooks/use-members';

/**
 * V11 A.S9 — TeamPage (members list) reskin per
 * `MEAPP_design/screens-team.jsx` TeamPage (lines 37-86).
 *
 * Partner ships a cards grid with avatar (color-coded by agent) +
 * name + ID + phone + email + 2 mini-KPIs (projects count + actions
 * this week). For our app, the Member wire shape carries NO PII (no
 * phone, no national_id — per `apps/web/src/models/member.vm.ts`) and
 * there is no per-member activity aggregator endpoint, so the
 * activity tile + phone row drop out.
 *
 * What this slice ports:
 *   - Filters bar: title + search + primary "Invite" CTA (partner
 *     pattern — same as A.S4 / A.S8).
 *   - Card grid (default): avatar (hashed-palette initials) + name +
 *     state badge + primary chip + role + email + created relative.
 *   - Client-side search on name + email + roleLabel (lowercase).
 *     Server-side `?q=` needs a BE slice.
 *
 * What it doesn't port (flagged via `members.dataPendingHint`):
 *   - Per-member activity KPIs (projects assigned, actions this
 *     week) — needs a per-member aggregator the wire doesn't expose.
 *   - Per-member color (partner hard-codes one per agent) — we hash
 *     userId to a stable palette index instead.
 *   - Phone row — Member wire shape carries no phone (D.27 invite
 *     lifecycle: only email + name are part of the membership).
 *
 * Manager-only resource (D.17) — sidebar hides the link for
 * non-Managers, BE returns 403 (api-client surfaces as `loadFailed`).
 * The list shows ACTIVE + PENDING + REVOKED rows (forensic value for
 * ISO A.9.4.1 — visible attestation of role assignments).
 */

// Stable hashed palette so each member gets a deterministic accent
// across reloads. Reuses partner's navy / info / success / warning /
// danger token families.
const AVATAR_PALETTE: { bg: string; ring: string }[] = [
  { bg: 'var(--navy-700)', ring: 'var(--navy-100)' },
  { bg: 'var(--info-700)', ring: 'var(--info-100)' },
  { bg: 'var(--success-700)', ring: 'var(--success-100)' },
  { bg: 'var(--warning-700)', ring: 'var(--warning-100)' },
  { bg: 'var(--danger-700)', ring: 'var(--danger-100)' },
];

function paletteFor(userId: string): { bg: string; ring: string } {
  // Cheap deterministic hash — sum char codes mod palette length.
  let sum = 0;
  for (let i = 0; i < userId.length; i++) sum = (sum + userId.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[sum % AVATAR_PALETTE.length]!;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0] ?? '') + (parts[1]![0] ?? '');
  return name.slice(0, 2);
}

export default function MembersPage() {
  const t = useTranslations('members');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const { data, isLoading, isError, refetch } = useMemberList({ limit: 25, cursor });

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const page = data?.page;

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.roleLabel.toLowerCase().includes(q),
    );
  }, [items, query]);

  if (isLoading) return <ListSkeleton rows={6} />;

  if (isError) {
    return (
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
          {t('loadFailed')}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          {tp('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filters bar */}
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="me-auto text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('listTitle')}
        </h1>

        <div className="relative flex-1" style={{ maxWidth: 400, minWidth: 200 }}>
          <Search
            className="pointer-events-none absolute h-4 w-4"
            style={{
              color: 'var(--text-soft)',
              insetInlineEnd: 12,
              top: '50%',
              transform: 'translateY(-50%)',
            }}
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="input"
            style={{ paddingInlineEnd: 38 }}
          />
        </div>

        <Link href="/members/new" className="btn btn-primary">
          <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
          <span>{t('invite')}</span>
        </Link>
      </div>

      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {t('dataPendingHint')}
      </p>

      {filteredItems.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {items.length === 0 ? t('empty') : t('noResults')}
        </p>
      ) : (
        <div
          className="grid gap-3.5"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
        >
          {filteredItems.map((m) => {
            const palette = paletteFor(m.userId);
            return (
              <Link
                key={m.userId}
                href={`/members/${m.userId}`}
                className="card card-pad flex flex-col gap-3 transition-shadow hover:shadow-md focus:outline-none focus-visible:shadow-md"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="avatar avatar-lg"
                    style={{
                      background: palette.bg,
                      color: '#fff',
                      boxShadow: `0 0 0 3px ${palette.ring}`,
                    }}
                    aria-hidden="true"
                  >
                    {initialsOf(m.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate text-sm font-semibold"
                      style={{ color: 'var(--text)' }}
                    >
                      <NameDisplay name={m.name} />
                    </div>
                    <div
                      className="mt-0.5 truncate text-[11px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {m.roleLabel} · {m.createdRelative}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge color={m.stateColor}>{m.stateLabel}</StatusBadge>
                  {m.isPrimary && <span className="badge badge-info">{t('primary')}</span>}
                </div>

                <div
                  className="flex items-center gap-2 text-[12px]"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <Mail
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--text-soft)' }}
                    aria-hidden="true"
                  />
                  <span className="truncate" dir="ltr">
                    <NameDisplay name={m.email} />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      <div className="flex flex-wrap items-center gap-2">
        {page?.has_more && page.cursor && (
          <Button variant="outline" size="sm" onClick={() => setCursor(page.cursor ?? undefined)}>
            {tp('next')}
          </Button>
        )}
        {cursor && (
          <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
            {tp('resetToFirstPage')}
          </Button>
        )}
      </div>
    </div>
  );
}
