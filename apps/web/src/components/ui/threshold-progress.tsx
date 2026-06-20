'use client';

import { useTranslations } from 'next-intl';

/**
 * ThresholdProgress — E2 Wave-2 E2.2-S3 "תמונת מצב" board primitive.
 *
 * An accessible progress bar showing `consentedPct` toward `targetSignaturePct`
 * (the legal consent target). It is the calm visual answer to "how close are we
 * to the threshold?" — it does NOT celebrate (no confetti); crossing the line is
 * a quiet, success-toned state, never crossing is a calm amber.
 *
 * A11y contract (asserted by `threshold-progress.spec.ts`):
 *   - `role="progressbar"` with `aria-valuemin={0}` / `aria-valuemax={100}` /
 *     `aria-valuenow={consentedPct}`.
 *   - A meaningful `aria-valuetext` that screen-readers announce instead of a
 *     bare "66%": e.g. "66% מתוך יעד 66% — היעד הושג" (met) /
 *     "50% מתוך יעד 66%" (not met) / "50% — לא הוגדר יעד" (no target).
 *
 * §2.1 basis label — the consent % is ALWAYS accompanied by the basis caption
 * "לפי שיעור הבעלות" (consent is share-weighted, B0). The number is NEVER a bare
 * legal claim; the basis caption sits next to it.
 *
 * Motion (M1) — the bar FILL transitions via the `--motion-duration-slow` +
 * `--motion-ease-out` tokens. The global `prefers-reduced-motion: reduce` guard
 * in globals.css zeroes those duration tokens, so a reduced-motion user gets an
 * instant fill (no animation) for free.
 *
 * RTL — the fill grows from the inline-start (`inset-inline-start`) so it reads
 * correctly right-to-left (he) and left-to-right (en).
 *
 * Token-only styling: success / warning / subtle tokens, no default-palette
 * class, no inline color literal (the ratchet holds).
 */
export interface ThresholdProgressProps {
  /** Share-weighted consent percentage achieved (0–100). */
  consentedPct: number;
  /** The legal consent target percentage, or null when none is configured. */
  targetSignaturePct: number | null;
  /** Whether the consent line has crossed the legal target. Drives the calm
   *  success vs amber tone (NOT a celebration). */
  metThreshold: boolean;
}

/** Clamp a percent into the [0, 100] aria-valid range (defensive). */
function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function ThresholdProgress({
  consentedPct,
  targetSignaturePct,
  metThreshold,
}: ThresholdProgressProps) {
  const t = useTranslations('projects.threshold');
  const tConsent = useTranslations('consent');

  const pct = clampPct(consentedPct);
  const hasTarget = targetSignaturePct !== null;
  const targetPct = hasTarget ? clampPct(targetSignaturePct) : null;

  // The announced text — a full sentence, not a bare percent. Selected by
  // (hasTarget × metThreshold) so a screen-reader user hears the relationship
  // to the target, not just the number.
  const valueText = !hasTarget
    ? t('valueTextNoTarget', { pct })
    : metThreshold
      ? t('valueTextMet', { pct, target: targetPct! })
      : t('valueTextBelow', { pct, target: targetPct! });

  // Calm tone: success once the line is crossed, amber otherwise. No green
  // "celebration" — just a quiet state change.
  const fill = metThreshold ? 'var(--success-600)' : 'var(--warning-600)';
  const stateLabel = metThreshold ? t('stateMet') : t('stateBelow');
  const stateColor = metThreshold ? 'var(--success-700)' : 'var(--warning-700)';

  return (
    <div className="flex flex-col gap-1.5">
      {/* The % + the MANDATORY basis caption ("לפי שיעור הבעלות") + the target. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
        <span className="tabular font-semibold" dir="ltr" style={{ color: 'var(--text)' }}>
          {t('pct', { pct })}
        </span>
        {/* §2.1 — never a bare legal claim; the basis caption rides with the %. */}
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {tConsent('basisShare')}
        </span>
        {hasTarget && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            · {t('target', { pct: targetPct! })}
          </span>
        )}
        {hasTarget && (
          <span className="text-xs font-medium" style={{ color: stateColor }}>
            · {stateLabel}
          </span>
        )}
      </div>

      <div
        className="relative w-full overflow-hidden rounded-full"
        style={{ height: 10, background: 'var(--bg-subtle)' }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={valueText}
        aria-label={t('ariaLabel')}
      >
        <div
          className="absolute inset-y-0"
          style={{
            insetInlineStart: 0,
            width: `${pct}%`,
            background: fill,
            // M1 motion — animate the fill width; reduced-motion zeroes the
            // duration token globally so this is instant for those users.
            transition: 'width var(--motion-duration-slow) var(--motion-ease-out)',
          }}
        />
        {/* The target tick — a calm marker where the legal line sits, so the
            bar reads "how far to the line" even before it's crossed. */}
        {hasTarget && targetPct !== null && targetPct > 0 && targetPct < 100 && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0"
            style={{
              insetInlineStart: `${targetPct}%`,
              width: 2,
              background: 'var(--border-strong)',
            }}
          />
        )}
      </div>
    </div>
  );
}
