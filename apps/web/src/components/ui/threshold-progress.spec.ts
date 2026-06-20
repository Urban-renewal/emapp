/**
 * E2 Wave-2 E2.2-S3 — ThresholdProgress render + a11y contract.
 *
 * The board's "תמונת מצב" progress primitive. We assert the a11y contract on the
 * real `renderToStaticMarkup` output (no DOM, node-env): role="progressbar" with
 * the value triplet + a MEANINGFUL `aria-valuetext` (never a bare percent), the
 * MANDATORY basis label ("לפי שיעור הבעלות", §2.1 / B0) next to the %, the calm
 * met/below state, and the M1 motion transition on the fill (reduced-motion is a
 * global token concern, asserted by it being a `--motion-duration-*` reference).
 *
 * next-intl is mocked to a faithful interpolating stub (real he strings) so the
 * aria-valuetext assertions read like the live render.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Faithful interpolating stub — mirrors the real he.json copy so the
// aria-valuetext examples in the assertions match what a screen-reader hears.
vi.mock('next-intl', () => {
  const HE: Record<string, Record<string, string>> = {
    'projects.threshold': {
      pct: '{pct}%',
      target: 'יעד {pct}%',
      ariaLabel: 'התקדמות ההסכמות לעבר היעד',
      stateMet: 'היעד הושג',
      stateBelow: 'טרם הושג היעד',
      valueTextMet: '{pct}% מתוך יעד {target}% — היעד הושג',
      valueTextBelow: '{pct}% מתוך יעד {target}%',
      valueTextNoTarget: '{pct}% — לא הוגדר יעד',
    },
    consent: { basisShare: 'לפי שיעור הבעלות' },
  };
  return {
    useTranslations: (ns: string) => (key: string, vars?: Record<string, unknown>) => {
      let s = HE[ns]?.[key] ?? `${ns}.${key}`;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
      return s;
    },
  };
});

import { ThresholdProgress } from './threshold-progress';

function render(props: Parameters<typeof ThresholdProgress>[0]): string {
  return renderToStaticMarkup(createElement(ThresholdProgress, props));
}

describe('ThresholdProgress — a11y + render contract', () => {
  it('1) exposes the progressbar role + the value triplet', () => {
    const html = render({ consentedPct: 50, targetSignaturePct: 66, metThreshold: false });
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="50"');
  });

  it('2) aria-valuetext is meaningful (below target) — not a bare percent', () => {
    const html = render({ consentedPct: 50, targetSignaturePct: 66, metThreshold: false });
    expect(html).toContain('aria-valuetext="50% מתוך יעד 66%"');
  });

  it('3) aria-valuetext announces the met state when the threshold is crossed', () => {
    const html = render({ consentedPct: 66, targetSignaturePct: 66, metThreshold: true });
    expect(html).toContain('aria-valuetext="66% מתוך יעד 66% — היעד הושג"');
  });

  it('4) aria-valuetext handles the no-target case', () => {
    const html = render({ consentedPct: 40, targetSignaturePct: null, metThreshold: false });
    expect(html).toContain('aria-valuetext="40% — לא הוגדר יעד"');
  });

  it('5) ALWAYS carries the basis label "לפי שיעור הבעלות" next to the % (§2.1 / B0)', () => {
    const met = render({ consentedPct: 80, targetSignaturePct: 66, metThreshold: true });
    const below = render({ consentedPct: 10, targetSignaturePct: 66, metThreshold: false });
    const noTarget = render({ consentedPct: 10, targetSignaturePct: null, metThreshold: false });
    expect(met).toContain('לפי שיעור הבעלות');
    expect(below).toContain('לפי שיעור הבעלות');
    expect(noTarget).toContain('לפי שיעור הבעלות');
  });

  it('6) shows the met state calmly (success token) — no celebration', () => {
    const html = render({ consentedPct: 90, targetSignaturePct: 66, metThreshold: true });
    expect(html).toContain('היעד הושג');
    // Calm success tone on the fill, not a "celebration" — token, not literal.
    expect(html).toContain('var(--success-600)');
    // No confetti / emoji / exclamation noise.
    expect(html).not.toContain('🎉');
    expect(html).not.toContain('!');
  });

  it('7) shows the below state in the calm amber/warning token', () => {
    const html = render({ consentedPct: 20, targetSignaturePct: 66, metThreshold: false });
    expect(html).toContain('טרם הושג היעד');
    expect(html).toContain('var(--warning-600)');
  });

  it('8) animates the fill via the M1 motion token (reduced-motion respected globally)', () => {
    const html = render({ consentedPct: 50, targetSignaturePct: 66, metThreshold: false });
    expect(html).toContain('var(--motion-duration-slow)');
    expect(html).toContain('var(--motion-ease-out)');
  });

  it('9) clamps an out-of-range pct into the aria-valid [0,100] window', () => {
    const over = render({ consentedPct: 140, targetSignaturePct: 66, metThreshold: true });
    const under = render({ consentedPct: -5, targetSignaturePct: 66, metThreshold: false });
    expect(over).toContain('aria-valuenow="100"');
    expect(under).toContain('aria-valuenow="0"');
  });

  it('10) uses no raw hex/rgb/hsl color literal (token ratchet stays green)', () => {
    const html = render({ consentedPct: 50, targetSignaturePct: 66, metThreshold: false });
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(html).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });
});
