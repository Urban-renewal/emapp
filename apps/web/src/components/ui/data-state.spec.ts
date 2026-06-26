/**
 * E2 Wave-0 C2 — <DataState> wrapper acceptance test.
 *
 * DataState is the ONE reusable treatment of the four non-happy data states
 * (forbidden / error+retry / loading-skeleton / empty-guided), replacing the
 * ad-hoc `return null` blanks. This test renders the REAL component in each
 * state and asserts the rendered markup — so a regression that, say, drops the
 * retry button or swaps the 403 panel for the error panel fails loudly here.
 *
 * Harness mirrors `agent-home.spec.ts` / `sidebar.spec.ts`: vitest env is
 * `node` (this package ships NO jsdom / @testing-library — see
 * `project-document-upload.spec.ts` docstring), so we render via
 * `react-dom/server`'s `renderToStaticMarkup` (an HTML string we assert on)
 * and stub next-intl. `onRetry` firing is proven by a `Button` stub that
 * invokes its `onClick` at render time into a spy — the SAME seam the live
 * retry button wires, without needing a DOM click.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// next-intl: `useTranslations('dataState')` → keyed lookup into the REAL
// he.json copy. A key the component asks for that isn't modelled renders a
// visible MISSING:<key> → loud failure (and the i18n-coverage guard catches
// the inverse — a referenced key absent from the locale JSONs).
const T: Record<string, string> = {
  loading: 'טוען...',
  errorTitle: 'לא הצלחנו לטעון את הנתונים',
  errorBody: 'אירעה תקלה זמנית. אפשר לנסות שוב.',
  retry: 'נסה שוב',
  forbiddenTitle: 'אין לך גישה',
  forbiddenBody: 'אין לך הרשאה לצפות בתוכן הזה.',
  emptyDefault: 'אין כאן עדיין נתונים.',
};

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => T[key] ?? `MISSING:${key}`,
}));

// Button stub: render an actual <button>. When `onClick` is present we ALSO
// fire it once at render time into whatever spy the test installed — that
// proves the retry wiring reaches the Button's onClick without a DOM event.
const captured: { onClick: (() => void) | null } = { onClick: null };
vi.mock('./button', () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
    captured.onClick = onClick ?? null;
    return createElement('button', { type: 'button' }, children);
  },
}));

import { ApiClientError } from '@/lib/api/errors';

import { DataState } from './data-state';

const CHILD = createElement('p', null, 'happy-path-body');

describe('<DataState> — the four non-happy states + happy path', () => {
  it('1) forbidden → muted access-denied panel, NO retry button', () => {
    captured.onClick = null;
    const html = renderToStaticMarkup(
      createElement(
        DataState,
        { isForbidden: true, isLoading: false, emptyTitle: 'x', onRetry: vi.fn() },
        CHILD,
      ),
    );
    expect(html).toContain('אין לך גישה');
    expect(html).toContain('אין לך הרשאה לצפות בתוכן הזה.');
    // forbidden is terminal — no retry, and the happy child is NOT rendered.
    expect(html).not.toContain('<button');
    expect(html).not.toContain('happy-path-body');
  });

  it('2a) error → calm message + retry button rendered', () => {
    const html = renderToStaticMarkup(
      createElement(
        DataState,
        { isError: true, isLoading: false, emptyTitle: 'x', onRetry: vi.fn() },
        CHILD,
      ),
    );
    expect(html).toContain('לא הצלחנו לטעון את הנתונים');
    expect(html).toContain('נסה שוב'); // retry label
    expect(html).toContain('<button');
    expect(html).not.toContain('happy-path-body');
  });

  it('2b) error → onRetry actually fires when the retry button is invoked', () => {
    const onRetry = vi.fn();
    captured.onClick = null;
    renderToStaticMarkup(
      createElement(DataState, { isError: true, isLoading: false, emptyTitle: 'x', onRetry }),
    );
    // The Button stub captured the onClick DataState passed in — invoke it.
    // (cast: TS can't track the assignment inside the hoisted vi.mock factory,
    // so it narrows the field to its initializer `null` — the cast restores
    // the real runtime type the factory writes.)
    const fired = captured.onClick as unknown as (() => void) | null;
    expect(fired).toBeTypeOf('function');
    fired?.();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('2c) error WITHOUT onRetry → message but no retry button', () => {
    const html = renderToStaticMarkup(
      createElement(DataState, { isError: true, isLoading: false, emptyTitle: 'x' }, CHILD),
    );
    expect(html).toContain('לא הצלחנו לטעון את הנתונים');
    expect(html).not.toContain('<button');
  });

  it('2d) a 403 error (derived, no explicit isForbidden) renders the access-denied panel', () => {
    // isPermissionDenied keys off ApiClientError.code === 'forbidden'. A plain
    // error object is NOT forbidden → it must take the retryable error branch,
    // NOT the access-denied one. (Guards the derivation precedence.)
    const html = renderToStaticMarkup(
      createElement(
        DataState,
        {
          isError: true,
          isLoading: false,
          error: new Error('boom'),
          emptyTitle: 'x',
          onRetry: vi.fn(),
        },
        CHILD,
      ),
    );
    expect(html).toContain('לא הצלחנו לטעון את הנתונים'); // error, not forbidden
    expect(html).not.toContain('אין לך גישה');
  });

  it('2e) 0.S6 #38 — a real ApiClientError(403) passed through derives the access-denied panel', () => {
    // The documents cockpit + completeness board used to hard-code
    // `error={undefined}`, so a 403 fell through to the retry treatment
    // (telling the user to "try again" on something a retry can't fix). Now
    // they pass the real query `error` through — proving that the ACTUAL
    // ApiClientError the board hooks throw on a 403 lands in the forbidden
    // branch (legible access-denied), not the retry branch.
    const forbidden = new ApiClientError({ code: 'forbidden', message: 'no access' });
    const html = renderToStaticMarkup(
      createElement(
        DataState,
        {
          isError: true,
          isLoading: false,
          error: forbidden,
          emptyTitle: 'x',
          onRetry: vi.fn(),
        },
        CHILD,
      ),
    );
    expect(html).toContain('אין לך גישה'); // forbidden, NOT the retry error
    expect(html).not.toContain('לא הצלחנו לטעון את הנתונים');
    expect(html).not.toContain('<button'); // forbidden is terminal — no retry
  });

  it('3) loading → skeleton (the .skeleton shimmer primitive)', () => {
    const html = renderToStaticMarkup(
      createElement(DataState, { isLoading: true, emptyTitle: 'x' }, CHILD),
    );
    expect(html).toContain('skeleton'); // the token-driven shimmer class
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('happy-path-body');
  });

  it("3b) loading skeleton='list' → ListSkeleton rows", () => {
    const html = renderToStaticMarkup(
      createElement(DataState, { isLoading: true, skeleton: 'list', emptyTitle: 'x' }, CHILD),
    );
    expect(html).toContain('skeleton');
    expect(html).toContain('aria-busy="true"');
  });

  it('4) empty → guided empty state: title + hint + action, no blank', () => {
    const html = renderToStaticMarkup(
      createElement(
        DataState,
        {
          isLoading: false,
          isEmpty: true,
          emptyTitle: 'אין עדיין פרויקטים',
          emptyHint: 'צרו את הפרויקט הראשון כדי להתחיל',
          emptyAction: createElement('a', { href: '/projects/new' }, 'פרויקט חדש'),
        },
        CHILD,
      ),
    );
    expect(html).toContain('אין עדיין פרויקטים'); // title
    expect(html).toContain('צרו את הפרויקט הראשון כדי להתחיל'); // hint
    expect(html).toContain('פרויקט חדש'); // primary action
    expect(html).not.toContain('happy-path-body');
  });

  it('5) happy path → children render (none of the four states active)', () => {
    const html = renderToStaticMarkup(
      createElement(
        DataState,
        { isLoading: false, isError: false, isEmpty: false, emptyTitle: 'x' },
        CHILD,
      ),
    );
    expect(html).toContain('happy-path-body');
    expect(html).not.toContain('אין לך גישה');
    expect(html).not.toContain('skeleton');
  });

  it('6) precedence: forbidden wins over error+loading+empty all set', () => {
    const html = renderToStaticMarkup(
      createElement(
        DataState,
        {
          isForbidden: true,
          isError: true,
          isLoading: true,
          isEmpty: true,
          emptyTitle: 'x',
          onRetry: vi.fn(),
        },
        CHILD,
      ),
    );
    expect(html).toContain('אין לך גישה');
    expect(html).not.toContain('<button'); // not the error branch
    expect(html).not.toContain('aria-busy'); // not the loading branch
  });
});
