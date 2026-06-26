/**
 * 0.S6 #6 — TRANSIENT-vs-TERMINAL error legibility on the public signing page
 * (`apps/web/src/app/sign/[token]/page.tsx`).
 *
 * Defect: ANY non-200 (incl. 5xx / 429 / timeout / network) collapsed into the
 * terminal "הקישור אינו תקף / פג תוקף / כבר נחתם" dead-end. A non-technical
 * resident hit by a momentary outage was falsely told their link is dead.
 *
 * Fix: a transient class (5xx / 429 / 408 / thrown-fetch) → a RETRYABLE stage
 * with a "נסו שוב" affordance; 401 / 404 / 410 (and any other status) → the
 * genuine terminal invalid screen. Anti-enumeration is PRESERVED: the three
 * terminal statuses are NOT distinguished from one another.
 *
 * Two layers asserted here:
 *  1. `isTransientStatus` — the pure classifier (the load-bearing split).
 *  2. The rendered `retryable` vs `invalid` stages (copy + retry button vs
 *     terminal dead-end), using the same useState-queue SSR harness as the
 *     sibling `page-deadlink.spec.ts`.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real shipped copy — assert the rendered text is the ACTUAL resident-facing
// strings, and that the retryable copy carries no anti-enumeration leak.
import enMessages from '@/messages/en.json';
import heMessages from '@/messages/he.json';

const COPY = {
  invalidTitle: 'הקישור אינו תקף',
  retryableTitle: 'שגיאה זמנית',
  retryableBody: 'לא הצלחנו לטעון את המסמך כרגע. ייתכן שזו תקלת רשת זמנית. נסו שוב בעוד רגע.',
  retry: 'נסו שוב',
} as const;

const tFn = (key: string, vars?: Record<string, unknown>) => {
  const base = (COPY as Record<string, string>)[key] ?? `MISSING:${key}`;
  if (vars && 'when' in vars) return `${base}`;
  return base;
};
(tFn as unknown as { rich: unknown }).rich = (_key: string) => 'RICH';

vi.mock('next-intl', () => ({
  useTranslations: () => tFn,
  useLocale: () => 'he',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' }),
}));

vi.mock('@/components/ui/name-display', () => ({
  NameDisplay: ({ name }: { name: string }) => createElement('span', null, name),
}));

vi.mock('./_signature-canvas', () => ({
  SignatureCanvas: () => createElement('div', { 'data-testid': 'canvas-stub' }),
}));

// useState queue — drive `stage` deterministically; useEffect no-op so the
// real loader never overwrites the seeded stage (mirrors page-deadlink.spec).
let stateQueue: unknown[] = [];
let stateCursor = 0;

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const idx = stateCursor;
      stateCursor += 1;
      const has = idx < stateQueue.length && stateQueue[idx] !== undefined;
      const seeded = has ? stateQueue[idx] : typeof initial === 'function' ? initial() : initial;
      const setter = vi.fn();
      return [seeded, setter];
    },
    useEffect: () => undefined,
  };
});

import SignPage, { isTransientStatus } from './page';

function renderStage(stage: 'invalid' | 'retryable'): string {
  // Slot order MUST mirror page.tsx's useState call order:
  //   [0]stage [1]preview [2]doneAt [3]submitError [4]canvasEmpty
  //   [5]consentChecked [6]previewFailed [7]reloadKey
  stateQueue = [stage, null, null, null, true, false, false, 0];
  stateCursor = 0;
  return renderToStaticMarkup(createElement(SignPage));
}

beforeEach(() => {
  stateQueue = [];
  stateCursor = 0;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('0.S6 #6 — isTransientStatus (the transient/terminal split)', () => {
  it('classifies 5xx / 429 / 408 as TRANSIENT (retryable)', () => {
    for (const s of [500, 502, 503, 504, 429, 408]) {
      expect(isTransientStatus(s), `status ${s} must be transient`).toBe(true);
    }
  });

  it('classifies 401 / 404 / 410 / 400 as TERMINAL (NOT transient) — anti-enumeration intact', () => {
    // The three anti-enumeration statuses (401 expired/forged, 404 not-found,
    // 410 used) plus 400 must NOT be transient → they collapse to the single
    // terminal invalid screen with no retry oracle.
    for (const s of [400, 401, 403, 404, 410]) {
      expect(isTransientStatus(s), `status ${s} must be terminal`).toBe(false);
    }
  });
});

describe('0.S6 #6 — retryable vs terminal render', () => {
  it('retryable stage shows the transient title/body + a retry button (NOT the dead-end)', () => {
    const html = renderStage('retryable');
    expect(html).toContain(COPY.retryableTitle);
    expect(html).toContain(COPY.retryableBody);
    // A real retry affordance (button), not a terminal screen.
    expect(html).toMatch(/<button[^>]*>[^<]*נסו שוב/);
    // It must NOT be the terminal dead-end.
    expect(html).not.toContain(COPY.invalidTitle);
  });

  it('invalid stage stays the TERMINAL dead-end (no retry button, no transient copy)', () => {
    const html = renderStage('invalid');
    expect(html).toContain(COPY.invalidTitle);
    expect(html).not.toContain(COPY.retryableTitle);
    expect(html).not.toContain(COPY.retryableBody);
    // No retry button on the terminal screen (the recovery there is the
    // portal-login CTA, an anchor — covered by page-deadlink.spec).
    expect(html).not.toMatch(/<button[^>]*>[^<]*נסו שוב/);
  });

  it('shipped retryable copy carries no anti-enumeration reason word', () => {
    const heSign = (heMessages as { sign: Record<string, string> }).sign;
    const enSign = (enMessages as { sign: Record<string, string> }).sign;
    const FORBIDDEN = ['expir', 'cancel', 'revok', 'forg', 'signed', 'פג תוקף', 'בוטל', 'נחתם'];
    for (const key of ['retryableTitle', 'retryableBody', 'retry'] as const) {
      const he = heSign[key];
      const en = enSign[key];
      expect(he, `he.json sign.${key} must exist`).toBeTruthy();
      expect(en, `en.json sign.${key} must exist`).toBeTruthy();
      for (const word of FORBIDDEN) {
        expect(
          `${he} ${en}`.toLowerCase().includes(word.toLowerCase()),
          `sign.${key} leaks reason word "${word}"`,
        ).toBe(false);
      }
    }
  });
});
