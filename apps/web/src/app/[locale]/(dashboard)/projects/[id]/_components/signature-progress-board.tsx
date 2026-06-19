'use client';

import { useTranslations } from 'next-intl';

import { DataState } from '@/components/ui/data-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ThresholdProgress } from '@/components/ui/threshold-progress';
import { useSignatureProgress } from '@/hooks/use-projects';

/**
 * Phase-6 "תמונת מצב" — project signature-progress BOARD (S5a, read-only).
 *
 * Renders the headline consent line — "X מתוך Y דירות הסכימו · Z% · יעד W%" —
 * plus a progress bar (green once the legal threshold is met, amber otherwise).
 * When the project has no target, the target chip reads "לא הוגדר יעד".
 *
 * Pure READ over `GET /api/v1/projects/:id/signature-progress`; the wire carries
 * only aggregate counts + the project's own pct — no PII reaches this component.
 *
 * RTL note: the bar fills from the inline-start via the logical
 * `inset-inline-start` offset so it reads correctly in both directions.
 *
 * E2 Wave-0 C2 — the board USED to `return null` on error (a silent blank:
 * the "situation picture" vanished with no signal the user could act on). It
 * now routes the four non-happy states through the shared `<DataState>`
 * wrapper: a token-driven skeleton while loading and a CALM retry on error
 * (a 403 falls through to the muted access-denied treatment automatically).
 */
export function SignatureProgressBoard({ projectId }: { projectId: string }) {
  const t = useTranslations('projects.board');
  // E2 Wave-1 B0 — the consent % is share-weighted; §2.1 requires a basis label
  // ("לפי שיעור הבעלות") next to it so the number is never a bare percent.
  const { data, isLoading, isError, error, refetch } = useSignatureProgress(projectId);

  return (
    <DataState
      isLoading={isLoading}
      isError={isError}
      error={error}
      isEmpty={!isLoading && !isError && !data}
      onRetry={() => void refetch()}
      skeleton={<Skeleton className="h-20 w-full" />}
      emptyTitle={t('empty')}
    >
      {data && (
        <section aria-labelledby="proj-board-h" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h2
              id="proj-board-h"
              className="text-sm font-semibold"
              style={{ color: 'var(--text)' }}
            >
              {t('title')}
            </h2>
          </div>

          <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
            {t('summary', {
              consented: data.apartmentsConsented,
              total: data.totalApartments,
            })}
          </p>

          {/* E2 Wave-2 E2.2-S3 — the real ThresholdProgress: the consent % toward
              the legal target with the MANDATORY basis label ("לפי שיעור הבעלות")
              riding next to it (§2.1, B0), an accessible aria-valuetext, the
              met/below state shown calmly, and an M1-animated fill (reduced-motion
              respected). Replaces the board's old hand-rolled bar + duplicated
              pct/basis/target line — ThresholdProgress now owns that whole line. */}
          <ThresholdProgress
            consentedPct={data.consentedPct}
            targetSignaturePct={data.targetSignaturePct}
            metThreshold={data.metThreshold}
          />

          <div
            className="flex items-center gap-3 text-[11px]"
            style={{ color: 'var(--text-muted)' }}
          >
            <span className="tabular" dir="ltr">
              {t('signedCount', {
                signed: data.signaturesSigned,
                pending: data.signaturesPending,
              })}
            </span>
          </div>
        </section>
      )}
    </DataState>
  );
}
