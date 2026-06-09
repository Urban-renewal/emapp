'use client';

import type { SignatureMilestone } from '@emapp/shared-types';
import { useTranslations } from 'next-intl';

/**
 * Owner-approved staged overlay (Gate-6, Option A) — signature-progress bar with
 * milestone TICK MARKS.
 *
 * This is a PURE READ over the EXISTING progress number: `signedPct` is derived
 * from the already-wired `signaturesSignedCount / (signed + pending)` stats on
 * `ProjectListItem` (the same ratio the KPI cell shows). No new compute, no
 * weighting — the milestones + the legal target are rendered as markers on top
 * of that single number. A milestone whose `pct <= signedPct` shows a "reached"
 * state.
 *
 * RTL note: the bar fills from the inline-start (right, in he) via the logical
 * `inset-inline-start` offset on each tick, so it reads correctly in both dirs.
 */
export function SignatureProgressBar({
  signedCount,
  pendingCount,
  targetPct,
  milestones,
}: {
  signedCount: number;
  pendingCount: number;
  targetPct: number | null;
  milestones: SignatureMilestone[];
}) {
  const t = useTranslations('projects.progress');
  const total = signedCount + pendingCount;
  // EXISTING progress number: share of requested signatures that are signed.
  const signedPct = total > 0 ? Math.round((signedCount / total) * 100) : 0;

  // Markers = the milestones (sorted ascending) plus the legal target as the
  // final marker. Deduped so a milestone equal to the target collapses into
  // one tick labelled as the target.
  const ticks: Array<{ pct: number; label: string; isTarget: boolean; reached: boolean }> = [];
  const seen = new Set<number>();
  for (const m of [...milestones].sort((a, b) => a.pct - b.pct)) {
    if (m.pct < 1 || m.pct > 100 || seen.has(m.pct)) continue;
    seen.add(m.pct);
    ticks.push({
      pct: m.pct,
      label: m.label?.trim() ? m.label.trim() : `${m.pct}%`,
      isTarget: false,
      reached: signedPct >= m.pct,
    });
  }
  if (targetPct !== null && targetPct >= 1 && targetPct <= 100 && !seen.has(targetPct)) {
    ticks.push({
      pct: targetPct,
      label: t('targetMarker', { pct: targetPct }),
      isTarget: true,
      reached: signedPct >= targetPct,
    });
  } else if (targetPct !== null && seen.has(targetPct)) {
    // Milestone coincides with the legal target — promote that tick to target.
    const existing = ticks.find((tk) => tk.pct === targetPct);
    if (existing) {
      existing.isTarget = true;
      existing.label = t('targetMarker', { pct: targetPct });
    }
  }

  return (
    <section aria-labelledby="proj-progress-h" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="proj-progress-h" className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          {t('title')}
        </h2>
        <span className="tabular text-sm font-medium" dir="ltr" style={{ color: 'var(--text)' }}>
          {t('signedSummary', { signed: signedCount, total })}
        </span>
      </div>

      {/* Bar track + fill + ticks. The track is tall enough to host tick labels
          below; ticks are absolutely positioned by logical inline offset. */}
      <div className="relative" style={{ paddingBottom: 22 }}>
        <div
          className="relative w-full overflow-hidden rounded-full"
          style={{ height: 10, background: 'var(--bg-subtle)' }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={signedPct}
          aria-label={t('title')}
        >
          <div
            className="absolute inset-y-0"
            style={{
              insetInlineStart: 0,
              width: `${signedPct}%`,
              background: 'var(--navy-900)',
            }}
          />
        </div>
        {ticks.map((tk) => (
          <div
            key={`${tk.pct}-${tk.isTarget ? 't' : 'm'}`}
            className="absolute top-0 flex flex-col items-center"
            style={{
              insetInlineStart: `${tk.pct}%`,
              transform: 'translateX(-50%)',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'block',
                width: 2,
                height: 10,
                background: tk.reached
                  ? 'var(--success-600)'
                  : tk.isTarget
                    ? 'var(--navy-900)'
                    : 'var(--border-strong)',
              }}
            />
            <span
              className="tabular mt-1 whitespace-nowrap text-[10px]"
              dir="ltr"
              style={{
                color: tk.reached
                  ? 'var(--success-700)'
                  : tk.isTarget
                    ? 'var(--navy-900)'
                    : 'var(--text-muted)',
                fontWeight: tk.isTarget || tk.reached ? 600 : 400,
              }}
            >
              {tk.label}
              {tk.reached ? ` ✓` : ''}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
