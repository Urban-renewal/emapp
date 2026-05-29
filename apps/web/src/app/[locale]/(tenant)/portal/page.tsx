'use client';

import {
  CalendarClock,
  CheckCircle2,
  FileSignature,
  FileText,
  Home,
  MapPin,
  User,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect } from 'react';

import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  usePortalApartments,
  usePortalDocuments,
  usePortalMe,
  usePortalSignatures,
} from '@/hooks/use-portal';

/**
 * V11 A.S14b — Tenant Portal screens.
 *
 * Sub-slice 2 of A.S14 wires the 4 read-only GET endpoints from B.S4
 * (`/api/v1/portal/{me,apartment,documents,signatures}`) behind the
 * tenant chrome shipped in A.S14a.
 *
 * Error-state discipline (manual-audit bug #4 fix): TanStack's
 * `isError` flag is the primary signal, but we also treat
 * `!isLoading && !isFetching && data === undefined` as an error
 * fallback. This catches the edge case where a queryFn throws but
 * the throw doesn't fully propagate to `isError` (observed with the
 * api-client's emit-unauthenticated event path — the event fires
 * BEFORE the throw lands in TanStack's catch, and the resulting
 * `router.replace` navigation can race the error state). Without
 * the fallback the user sees the empty-state copy ("no apartments
 * found") even though the actual cause was an auth failure.
 *
 * Layout (single scrollable page, responsive):
 *  1. Hero — navy-gradient block with greeting (firstName from /me),
 *     project name (from the first apartment row), and an ownership
 *     pill summarising the tenant's first apartment.
 *  2. Apartment section — one card per row from /portal/apartment.
 *     Shows building+project, apartment designation, status badge,
 *     unit type, size/rooms, and ownership percentage. Most tenants
 *     own a single apartment; the array iteration handles edge cases
 *     (split households, multi-unit purchase) without a separate
 *     "pick an apartment" UX.
 *  3. Documents + Signatures (two-column on desktop, stacked on
 *     mobile) — each section renders its own scrollable list with
 *     empty-state copy.
 *
 * Scope deltas vs partner TenantPortal (screens-tenant.jsx):
 *  - ProgressTimeline / milestones — no wire data; deferred to a future
 *    BE slice.
 *  - ContactCard with contractor info — no wire data; deferred.
 *  - FAQ + QuestionsSection — out of D.40 scope; deferred.
 *  - Per-doc download — portal endpoints return metadata only; the
 *    tenant can ask the team for a copy. A future slice may add a
 *    tenant-scoped /documents/:id/download endpoint.
 *  - Signature open — the signing link is delivered out-of-band via
 *    SMS (D.12 LAW — token NEVER re-emitted on the wire). The
 *    signatures section shows status + metadata; the tenant uses
 *    the SMS link to actually sign.
 *
 * Data fetching: 4 parallel useQuery calls. Each section renders its
 * own skeleton + error state so a slow signatures fetch doesn't block
 * the hero/apartment paint.
 */
/**
 * Coalesce a TanStack query into a single explicit state for the
 * 4-way render switch (loading / error / empty / populated). The
 * `errored` branch captures both the canonical `isError` flag AND
 * the defensive `data === undefined && !fetching` fallback that
 * triggers when an unauth-event race makes `isError` lag behind
 * (manual-audit bug #4).
 */
function viewState<T>(q: {
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  data: T | undefined;
}): 'loading' | 'error' | 'ready' {
  if (q.isLoading) return 'loading';
  if (q.isError) return 'error';
  if (q.data === undefined && !q.isFetching) return 'error';
  return 'ready';
}

export default function TenantPortalPage() {
  const t = useTranslations('portal');
  const router = useRouter();
  const locale = useLocale();

  const me = usePortalMe();
  const apts = usePortalApartments();
  const docs = usePortalDocuments();
  const sigs = usePortalSignatures();

  const meState = viewState(me);
  const aptsState = viewState(apts);
  const docsState = viewState(docs);
  const sigsState = viewState(sigs);

  // Manual-audit bug #5 fix — belt-and-suspenders auth bounce.
  // The api-client's `emapp:unauthenticated` event + the layout's
  // TenantAuthGuard listener should redirect on auth failure, but
  // manual testing showed the listener occasionally misses the event
  // (React Strict Mode double-mount, effect timing vs query resolution
  // before the layout effect attaches).
  //
  // Two cooperating fallbacks here:
  //
  //  1. Inspect `me.error` directly. If it's an ApiClientError with an
  //     auth-shaped code, redirect.
  //  2. If TanStack's error didn't propagate (we observed cases where
  //     the query lands with data=undefined / isError=false despite a
  //     401), watch ALL FOUR query states. When every fetch settles
  //     into an `error`-or-empty state at once, the failure is
  //     org-wide (almost certainly auth) — redirect rather than show
  //     four side-by-side "load failed" messages.
  // If ALL FOUR queries reach the error state at once, the failure is
  // org-wide (almost certainly an auth issue — expired or missing
  // tenant_access_token). Redirect rather than showing four
  // side-by-side "load failed" messages with no recovery affordance.
  // Anti-redirect-loop: only fires when we're actually on `/portal`
  // (i.e. layout already mounted) so this can't kick off a navigation
  // chain.
  const allErrored =
    meState === 'error' && aptsState === 'error' && docsState === 'error' && sigsState === 'error';
  useEffect(() => {
    if (!allErrored) return;
    router.replace(`/${locale}/tenant/login`);
  }, [allErrored, router, locale]);

  // Hero copy depends on the me-fetch + the first apartment's project
  // name. Both are independent; we render a placeholder until they
  // arrive (the rest of the page renders regardless).
  const firstApt = aptsState === 'ready' ? apts.data?.[0] : undefined;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      {/* ── Hero ──────────────────────────────────────────────────── */}
      <section
        className="relative overflow-hidden"
        style={{
          background:
            'linear-gradient(140deg, var(--navy-900) 0%, var(--navy-700) 60%, var(--navy-600) 100%)',
          color: '#fff',
          borderRadius: 16,
          padding: '40px 32px',
        }}
        aria-labelledby="portal-hero-h"
      >
        {/* Subtle radial glow per partner */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(circle at 85% 20%, rgba(255,255,255,.08), transparent 55%), radial-gradient(circle at 10% 90%, rgba(255,255,255,.04), transparent 50%)',
          }}
        />

        <div className="relative flex flex-col gap-3">
          <div
            className="inline-flex items-center gap-2 self-start"
            style={{
              padding: '5px 12px',
              borderRadius: 999,
              background: 'rgba(255,255,255,.10)',
              border: '1px solid rgba(255,255,255,.14)',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: '#22c55e',
                boxShadow: '0 0 0 3px rgba(34,197,94,.25)',
              }}
            />
            <span>{t('hero.statusChip')}</span>
          </div>

          <div className="text-sm" style={{ color: 'rgba(255,255,255,.65)', fontWeight: 500 }}>
            {me.data
              ? t('hero.greeting', { firstName: me.data.firstName })
              : t('hero.greetingFallback')}
          </div>

          <h1
            id="portal-hero-h"
            className="font-bold"
            style={{ fontSize: 32, lineHeight: 1.15, letterSpacing: '-.01em' }}
          >
            {firstApt
              ? t('hero.titleWithProject', { project: firstApt.project.name })
              : t('hero.titleFallback')}
          </h1>

          <p
            className="text-sm"
            style={{ color: 'rgba(255,255,255,.78)', lineHeight: 1.6, maxWidth: 640 }}
          >
            {t('hero.lede')}
          </p>

          {/* Mini-stats row — only renders when we have apartment data */}
          {firstApt && (
            <div
              className="mt-3 flex flex-wrap gap-4"
              style={{
                padding: '14px 18px',
                background: 'rgba(255,255,255,.06)',
                border: '1px solid rgba(255,255,255,.12)',
                borderRadius: 12,
              }}
            >
              <StatTile label={t('hero.statApt')} value={firstApt.apartmentDesignation} />
              <StatTile label={t('hero.statOwnership')} value={firstApt.ownershipPctLabel} />
              <StatTile label={t('hero.statProjectStatus')} value={firstApt.project.statusLabel} />
            </div>
          )}
        </div>
      </section>

      {/* ── Apartment section ─────────────────────────────────────── */}
      <Section
        title={t('apartment.section')}
        icon={<Home className="h-4 w-4" aria-hidden="true" style={{ color: 'var(--navy-700)' }} />}
      >
        {aptsState === 'loading' ? (
          <SectionSkeleton lines={3} />
        ) : aptsState === 'error' ? (
          <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
            {t('apartment.loadFailed')}
          </p>
        ) : !apts.data || apts.data.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {t('apartment.empty')}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {apts.data.map((row) => (
              <div
                key={row.apartmentId}
                className="card card-pad flex flex-col gap-3"
                style={{ borderInlineStart: '3px solid var(--navy-700)' }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
                    <NameDisplay name={row.apartmentDesignation} />
                  </h3>
                  <StatusBadge color={row.statusColor}>{row.statusLabel}</StatusBadge>
                </div>

                <div
                  className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm"
                  style={{ color: 'var(--text)' }}
                >
                  <Fact icon={<MapPin className="h-3.5 w-3.5" aria-hidden="true" />}>
                    <NameDisplay name={row.building.addressLine} />
                  </Fact>
                  <Fact>
                    <span style={{ color: 'var(--text-muted)' }}>{t('apartment.project')}: </span>
                    <NameDisplay name={row.project.name} />
                    <span style={{ color: 'var(--text-muted)' }}> · {row.project.typeLabel}</span>
                  </Fact>
                  <Fact>
                    <span style={{ color: 'var(--text-muted)' }}>{t('apartment.unitType')}: </span>
                    {row.unitTypeLabel}
                  </Fact>
                  {row.sizeLabel && (
                    <Fact>
                      <span style={{ color: 'var(--text-muted)' }}>{t('apartment.size')}: </span>
                      {row.sizeLabel}
                    </Fact>
                  )}
                  {row.roomsLabel && (
                    <Fact>
                      <span style={{ color: 'var(--text-muted)' }}>{t('apartment.rooms')}: </span>
                      {row.roomsLabel}
                    </Fact>
                  )}
                  {row.entranceLabel && (
                    <Fact>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {t('apartment.entrance')}:{' '}
                      </span>
                      <NameDisplay name={row.entranceLabel} />
                    </Fact>
                  )}
                  <Fact icon={<User className="h-3.5 w-3.5" aria-hidden="true" />}>
                    <span style={{ color: 'var(--text-muted)' }}>{t('apartment.ownership')}: </span>
                    {row.ownershipPctLabel}
                    {row.ownershipRoleLabel && (
                      <>
                        <span style={{ color: 'var(--text-muted)' }}> · </span>
                        <NameDisplay name={row.ownershipRoleLabel} />
                      </>
                    )}
                  </Fact>
                </div>

                <div
                  className="flex"
                  style={{ paddingTop: 8, borderTop: '1px solid var(--border)' }}
                >
                  <StatusBadge color={row.project.statusColor}>
                    {row.project.statusLabel}
                  </StatusBadge>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── Documents + Signatures (two-column on desktop) ───────── */}
      <div
        className="grid gap-6"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}
      >
        {/* Documents */}
        <Section
          title={t('documents.section')}
          icon={
            <FileText className="h-4 w-4" aria-hidden="true" style={{ color: 'var(--navy-700)' }} />
          }
        >
          {docsState === 'loading' ? (
            <SectionSkeleton lines={3} />
          ) : docsState === 'error' ? (
            <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
              {t('documents.loadFailed')}
            </p>
          ) : !docs.data || docs.data.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('documents.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {docs.data.map((d) => (
                <li
                  key={d.id}
                  className="card card-pad flex items-start gap-3"
                  style={{ padding: 12 }}
                >
                  <FileText
                    className="mt-0.5 h-4 w-4 shrink-0"
                    aria-hidden="true"
                    style={{ color: 'var(--text-soft)' }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" style={{ color: 'var(--text)' }}>
                      <NameDisplay name={d.name} />
                    </div>
                    <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {d.typeLabel} · {d.sizeLabel} · {d.createdRelative}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {t('documents.downloadHint')}
          </p>
        </Section>

        {/* Signatures */}
        <Section
          title={t('signatures.section')}
          icon={
            <FileSignature
              className="h-4 w-4"
              aria-hidden="true"
              style={{ color: 'var(--navy-700)' }}
            />
          }
        >
          {sigsState === 'loading' ? (
            <SectionSkeleton lines={3} />
          ) : sigsState === 'error' ? (
            <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
              {t('signatures.loadFailed')}
            </p>
          ) : !sigs.data || sigs.data.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('signatures.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sigs.data.map((s) => (
                <li
                  key={s.id}
                  className="card card-pad flex items-start gap-3"
                  style={{ padding: 12 }}
                >
                  {s.status === 'signed' ? (
                    <CheckCircle2
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                      style={{ color: 'var(--success-700)' }}
                    />
                  ) : (
                    <CalendarClock
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                      style={{ color: 'var(--text-soft)' }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" style={{ color: 'var(--text)' }}>
                      <NameDisplay name={s.documentName} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <StatusBadge color={s.statusColor}>{s.statusLabel}</StatusBadge>
                      {s.isExpired && (
                        <span className="badge badge-danger">{t('signatures.expired')}</span>
                      )}
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {s.status === 'signed' && s.signedRelative
                        ? t('signatures.signedAt', { rel: s.signedRelative })
                        : s.status === 'pending'
                          ? t('signatures.expiresAt', { rel: s.expiresRelative })
                          : t('signatures.createdAt', { rel: s.createdRelative })}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {t('signatures.smsHint')}
          </p>
        </Section>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Small renderers — kept in this file because they're page-specific
// and not worth a separate components/ui surface.
// ──────────────────────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

function Section({ title, icon, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2
        className="flex items-center gap-2 text-sm font-semibold"
        style={{ color: 'var(--text)' }}
      >
        {icon}
        <span>{title}</span>
      </h2>
      {children}
    </section>
  );
}

interface FactProps {
  icon?: React.ReactNode;
  children: React.ReactNode;
}

function Fact({ icon, children }: FactProps) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      {icon}
      <span>{children}</span>
    </span>
  );
}

interface StatTileProps {
  label: string;
  value: string;
}

function StatTile({ label, value }: StatTileProps) {
  return (
    <div className="flex flex-col">
      <div className="text-[11px]" style={{ color: 'rgba(255,255,255,.6)' }}>
        {label}
      </div>
      <div className="text-base font-semibold tabular" style={{ color: '#fff' }}>
        {value}
      </div>
    </div>
  );
}

function SectionSkeleton({ lines }: { lines: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="card card-pad"
          style={{ padding: 12, height: 56, opacity: 0.4, background: 'var(--bg-subtle)' }}
        />
      ))}
    </div>
  );
}
