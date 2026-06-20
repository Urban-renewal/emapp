'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  isPermissionDenied,
  useApartmentHoldouts,
  useSignatureProgressApartments,
} from '@/hooks/use-projects';
import type { ApartmentSignatureProgressViewModel } from '@/models/apartment-signature-progress.vm';

/**
 * Phase-6 "תמונת מצב" — per-apartment DRILL-DOWN. An expandable section under the
 * S5a board: collapsed by default, fetches lazily on first open (the hook is
 * gated on `open`), then lists each apartment as
 * "דירה {number} · קומה {floor} · {signedOwners}/{totalOwners} חתמו" + a status
 * chip (success=consented / warning=partial / neutral=none).
 *
 * E2 Wave-2 E2.2-S3 — each NOT-fully-consented apartment gains a "מי תקוע / who's
 * stuck" sub-toggle. Expanding it loads the apartment's HOLDOUT owner NAMES from
 * the `view_owner_pii`-gated + audited B4 endpoint — ON DEMAND, per apartment,
 * NEVER eagerly for the whole board (so the per-access audit + PII reveal fire
 * only when a manager deliberately drills in). If the caller LACKS the capability
 * (403) OR before expanding, the row shows the no-name FALLBACK "דירה N · partial"
 * — number + partial state, no name. Every holdout name is wrapped in
 * `<NameDisplay>` (bidi-safe). The wire's base list still carries NO PII.
 */

export function SignatureProgressApartments({ projectId }: { projectId: string }) {
  const t = useTranslations('projects.boardApartments');
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useSignatureProgressApartments(projectId, open);

  const statusLabel = (row: ApartmentSignatureProgressViewModel): string => {
    switch (row.status) {
      case 'consented':
        return t('statusConsented');
      case 'partial':
        return t('statusPartial');
      default:
        return t('statusNone');
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="self-start text-sm font-medium"
        style={{
          color: 'var(--navy-900)',
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
        }}
      >
        {open ? t('toggleHide') : t('toggleShow')}
      </button>

      {open && (
        <div className="flex flex-col gap-1.5">
          {isLoading && (
            <div
              className="h-16 w-full animate-pulse rounded-md"
              style={{ background: 'var(--bg-subtle)' }}
              aria-hidden="true"
            />
          )}

          {isError && (
            <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
              {t('loadFailed')}
            </p>
          )}

          {!isLoading && !isError && data && data.length === 0 && (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('empty')}
            </p>
          )}

          {!isLoading && !isError && data && data.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {data.map((row) => (
                <li
                  key={row.apartmentId}
                  className="flex flex-col gap-1.5 rounded-md px-3 py-2"
                  style={{ background: 'var(--bg-subtle)' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm" style={{ color: 'var(--text)' }}>
                      {t('row', {
                        designation: row.designation,
                        signed: row.signedOwners,
                        total: row.totalOwners,
                      })}
                    </span>
                    <StatusBadge intent={row.intent}>{statusLabel(row)}</StatusBadge>
                  </div>
                  {/* Only NOT-fully-consented apartments have holdouts worth naming. */}
                  {row.status !== 'consented' && (
                    <HoldoutList
                      projectId={projectId}
                      apartmentId={row.apartmentId}
                      apartmentNumber={row.number}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * "מי תקוע" — the per-apartment holdout NAMES sub-list. Collapsed by default; the
 * names (PII) load ON DEMAND from the gated + audited B4 endpoint only when this
 * toggle is opened. NEVER returns bare `null`: each non-happy state renders an
 * explicit, calm treatment (loading / 403 → no-name fallback / error → retry /
 * empty). A 403 is terminal (a retry won't grant the capability) so it falls back
 * to the anonymous "דירה N · partial" line — the apartment number + partial state,
 * no name.
 */
function HoldoutList({
  projectId,
  apartmentId,
  apartmentNumber,
}: {
  projectId: string;
  apartmentId: string;
  apartmentNumber: string;
}) {
  const t = useTranslations('projects.boardApartments');
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error, refetch } = useApartmentHoldouts(
    projectId,
    apartmentId,
    open,
  );

  const forbidden = isError && isPermissionDenied(error);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="self-start text-xs font-medium"
        style={{
          color: 'var(--navy-900)',
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
        }}
      >
        {open ? t('holdoutsToggleHide') : t('holdoutsToggleShow')}
      </button>

      {open && (
        <div className="flex flex-col gap-1 ps-2">
          {isLoading && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {t('holdoutsLoading')}
            </p>
          )}

          {/* 403 → no-name FALLBACK: number + partial state, NO name. Terminal,
              so no retry affordance (a retry won't grant the capability). */}
          {forbidden && (
            <div className="flex flex-col gap-0.5">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {t('holdoutFallback', { number: apartmentNumber })}
              </p>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {t('holdoutsForbidden')}
              </p>
            </div>
          )}

          {/* Generic (non-403) load error → calm retry. */}
          {isError && !forbidden && (
            <div className="flex flex-col items-start gap-1">
              <p className="text-xs" style={{ color: 'var(--danger-700)' }}>
                {t('holdoutsLoadFailed')}
              </p>
              <button
                type="button"
                onClick={() => void refetch()}
                className="text-xs font-medium"
                style={{
                  color: 'var(--navy-900)',
                  background: 'transparent',
                  border: 0,
                  cursor: 'pointer',
                }}
              >
                {t('holdoutsRetry')}
              </button>
            </div>
          )}

          {!isLoading && !isError && data && data.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {t('holdoutsEmpty')}
            </p>
          )}

          {!isLoading && !isError && data && data.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {data.map((h) => (
                <li key={h.ownerId} className="text-xs" style={{ color: 'var(--text)' }}>
                  {h.name ? (
                    <NameDisplay name={h.name} />
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>{t('holdoutNoName')}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
