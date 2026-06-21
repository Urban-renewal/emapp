'use client';

import { ArrowLeft, Crosshair } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { DataState } from '@/components/ui/data-state';
import { NameDisplay } from '@/components/ui/name-display';
import { Skeleton } from '@/components/ui/skeleton';
import { useProjectLeverage } from '@/hooks/use-projects';

/**
 * Battle-Map BM-1 — the LEVERAGE card ("מפת קרב" entry, READ-ONLY).
 *
 * The north-star "situation picture at a glance": one calm line that answers
 * "what's your single highest-leverage move?" — the not-yet-fully-signed owner
 * whose signature moves the project's headline consent % the MOST toward target
 * (marginal-delta-to-headline ranking, BM-1-be). It is NOT a funnel and NOT a
 * cluttered dashboard — it flows to the eye: a label, the owner + apartment +
 * share, and the projected jump (e.g. "61% → 71% · מעל הסף").
 *
 * READ-ONLY this slice. The primary affordance is a read-safe "focus" link to
 * the leverage owner's apartment (the project-scoped surface that hosts the
 * holdouts / signature actions). There is NO state-changing mutation here — the
 * one-tap follow-up action is the separate HB-1 mutation slice.
 *
 * PII: the only PII is the owner name, `view_owner_pii`-gated on the BE (already
 * `null` when masked → the card reads an anonymous fallback). It is wrapped in
 * `<NameDisplay>` (bidi-spoof defence, §v9-H-3). national_id / phone never reach
 * this surface.
 *
 * Non-happy states route through the shared C2 `<DataState>` wrapper (calm
 * skeleton / retry / forbidden) — never a bare `null`. The `leverage: null`
 * all-clear ("every movable owner has signed") is a calm success line, NOT the
 * empty/error treatment, because it is a GOOD outcome to celebrate quietly.
 */
export function LeverageCard({ projectId }: { projectId: string }) {
  const t = useTranslations('projects.leverage');
  const tConsent = useTranslations('consent');
  const { data, isLoading, isError, error, refetch } = useProjectLeverage(projectId);

  return (
    <DataState
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={() => void refetch()}
      skeleton={<Skeleton className="h-16 w-full" />}
      // `leverage: null` is a happy ALL-CLEAR, not an empty state, so it is
      // handled below in the body — DataState never sees `isEmpty`.
      emptyTitle={t('allClearTitle')}
    >
      {data && (
        <section
          aria-labelledby="proj-leverage-h"
          className="flex flex-col gap-2"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2">
            <Crosshair
              className="h-4 w-4 shrink-0"
              style={{ color: 'var(--navy-900)' }}
              aria-hidden="true"
            />
            <h2
              id="proj-leverage-h"
              className="text-sm font-semibold"
              style={{ color: 'var(--text)' }}
            >
              {t('title')}
            </h2>
          </div>

          {data.leverage === null ? (
            // All-clear: every movable owner has already signed. Calm, positive.
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('allClearBody')}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {/* The headline leverage line — flows to the eye, single read. */}
              <p className="text-sm" style={{ color: 'var(--text)' }}>
                {data.leverage.ownerName !== null ? (
                  <NameDisplay name={data.leverage.ownerName} className="font-semibold" />
                ) : (
                  <span className="font-semibold">{t('ownerNoName')}</span>
                )}
                <span style={{ color: 'var(--text-muted)' }}>
                  {' · '}
                  <span className="tabular" dir="ltr">
                    {t('sharePct', { pct: data.leverage.ownerSharePct })}
                  </span>
                  {' '}
                  {t('inApartment', { apartment: data.leverage.apartmentLabel })}
                </span>
              </p>

              {/* The projected jump + threshold-crossing chip — the "why this is
                  your move" payload. The basis caption keeps the % from being a
                  bare legal claim (B0 / §2.1). */}
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="tabular text-sm font-medium"
                  dir="ltr"
                  style={{ color: 'var(--text)' }}
                >
                  {t('projection', {
                    current: data.currentPct,
                    projected: data.leverage.projectedPct,
                  })}
                </span>
                {data.leverage.crossesThreshold ? (
                  <span className="badge badge-success">
                    <span className="badge-dot" aria-hidden="true" />
                    <span>{t('crossesThreshold')}</span>
                  </span>
                ) : (
                  <span className="badge badge-neutral">
                    <span className="badge-dot" aria-hidden="true" />
                    <span>{t('belowThreshold')}</span>
                  </span>
                )}
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {tConsent('basisShare')}
                </span>
              </div>

              {/* READ-SAFE navigation only — "focus" links to the owner's
                  apartment (project-scoped surface). NO state-changing action on
                  this surface (the follow-up notification action is HB-1). */}
              <div className="mt-1">
                <Link
                  href={`/apartments/${data.leverage.apartmentId}`}
                  className="btn btn-secondary btn-sm inline-flex items-center gap-1.5"
                >
                  {t('focusCta')}
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
            </div>
          )}
        </section>
      )}
    </DataState>
  );
}
