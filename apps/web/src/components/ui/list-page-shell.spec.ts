/**
 * §P4-#13 — ADVERSARIAL spec for `ListPageShell` + `isPermissionDenied`.
 *
 * The fix: a 403 permission denial (`ApiClientError` with `code:'forbidden'`)
 * is TERMINAL — the shell renders a distinct access-denied state with NO
 * retry affordance. Every other error (network / 4xx / 5xx) keeps the
 * existing retryable banner WITH a retry button.
 *
 * Test strategy: the repo's vitest env is `node` with NO testing-library /
 * jsdom, and the spec glob is `src/**\/*.spec.ts` (NOT `.spec.tsx`), so JSX
 * cannot appear in this file (esbuild parses `.ts` as TS). We render the
 * component to an HTML string via `react-dom/server`'s `renderToStaticMarkup`
 * using `createElement` (no JSX) and assert on the concrete rendered HTML —
 * the real he/en copy strings and the `role="status"` marker. No tautologies.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/lib/api/errors';

import { ListPageShell, isPermissionDenied } from './list-page-shell';
import type { ListPageShellProps } from './list-page-shell';

// Concrete copy lifted verbatim from src/messages/{he,en}.json `projects.*`.
// Asserting on the real strings (not placeholders) keeps the test honest:
// if the branch wiring regresses, the wrong copy renders and the test fails.
const LOAD_FAILED = 'טעינת הרשימה נכשלה'; // projects.loadFailed
const RETRY = 'נסה שוב'; // projects.retry
const EMPTY = 'אין עדיין פרויקטים.'; // projects.empty (prefix)
// Apostrophe-free substrings of the en copy. React HTML-escapes `'` to
// `&#x27;` in the rendered markup, so we assert on distinctive fragments that
// don't straddle an apostrophe — still load-bearing (these strings appear
// ONLY in the access-denied branch).
const ACCESS_TITLE = 'have access to this'; // projects.accessDeniedTitle (en)
const ACCESS_BODY = 'include permission to view this list. Contact a manager if you need access.'; // projects.accessDeniedBody (en)

/**
 * Build props for the shell. Defaults model the "healthy" path; each test
 * overrides only the axis it exercises. `accessDeniedTitle` is DELIBERATELY
 * distinct from `loadFailedLabel` so that "title present" unambiguously proves
 * the new 403 branch fired (and not the `?? loadFailedLabel` fallback).
 */
function buildProps(overrides: Partial<ListPageShellProps> = {}): ListPageShellProps {
  return {
    isLoading: false,
    isError: false,
    error: undefined,
    itemCount: 1,
    page: undefined,
    cursor: undefined,
    loadFailedLabel: LOAD_FAILED,
    emptyLabel: EMPTY,
    retryLabel: RETRY,
    nextLabel: 'הבא',
    resetLabel: 'חזרה לעמוד הראשון',
    accessDeniedTitle: ACCESS_TITLE,
    accessDeniedBody: ACCESS_BODY,
    onRetry: vi.fn(),
    onNext: vi.fn(),
    onReset: vi.fn(),
    children: createElement('ul', { 'data-testid': 'rows' }, createElement('li', null, 'row-1')),
    ...overrides,
  };
}

function render(overrides: Partial<ListPageShellProps> = {}): string {
  return renderToStaticMarkup(createElement(ListPageShell, buildProps(overrides)));
}

function forbidden(): ApiClientError {
  return new ApiClientError({ code: 'forbidden', message: 'permission denied' });
}

describe('§P4-#13 / ListPageShell — 403 access-denied vs retryable error', () => {
  it('1) 403 (code:forbidden) → access-denied copy, role=status, and NO retry button', () => {
    const html = render({ isError: true, error: forbidden() });

    // access-denied state present...
    expect(html).toContain('role="status"');
    expect(html).toContain(ACCESS_TITLE);
    expect(html).toContain(ACCESS_BODY);

    // ...and NOTHING retryable. No <button> at all, no retry label, and the
    // generic destructive "loadFailed" banner copy must be absent.
    expect(html).not.toContain('<button');
    expect(html).not.toContain(RETRY);
    expect(html).not.toContain('text-destructive');
  });

  it('2a) non-forbidden ApiClientError (not_found) → retryable banner WITH retry, NO access-denied', () => {
    const html = render({
      isError: true,
      error: new ApiClientError({ code: 'not_found', message: 'missing' }),
    });

    expect(html).toContain('<button');
    expect(html).toContain(RETRY);
    expect(html).toContain(LOAD_FAILED);
    expect(html).toContain('text-destructive');

    // access-denied state must NOT appear for a 404.
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain(ACCESS_TITLE);
    expect(html).not.toContain(ACCESS_BODY);
  });

  it('2b) ApiClientError code:internal (500) → retryable banner WITH retry, NO access-denied', () => {
    const html = render({
      isError: true,
      error: new ApiClientError({ code: 'internal', message: 'boom' }),
    });
    expect(html).toContain('<button');
    expect(html).toContain(RETRY);
    expect(html).not.toContain(ACCESS_TITLE);
  });

  it('2c) plain Error (simulated network failure / non-ApiClientError) → retryable banner', () => {
    const html = render({ isError: true, error: new Error('fetch failed') });
    expect(html).toContain('<button');
    expect(html).toContain(RETRY);
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain(ACCESS_TITLE);
  });

  it('2d) isError with error=undefined (back-compat) → retryable banner, never access-denied', () => {
    const html = render({ isError: true, error: undefined });
    expect(html).toContain('<button');
    expect(html).toContain(RETRY);
    expect(html).not.toContain(ACCESS_TITLE);
    expect(html).not.toContain('role="status"');
  });
});

describe('§P4-#13 / ListPageShell — no regression on loading / empty / normal', () => {
  it('3a) loading → skeleton (aria-busy), no access-denied, no error banner', () => {
    const html = render({ isLoading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain(ACCESS_TITLE);
    expect(html).not.toContain(LOAD_FAILED);
    expect(html).not.toContain(RETRY);
  });

  it('3b) empty (itemCount 0, no error) → empty copy, no children, no access-denied/error', () => {
    const html = render({
      itemCount: 0,
      children: createElement('ul', { 'data-testid': 'rows' }, createElement('li', null, 'row-1')),
    });
    expect(html).toContain(EMPTY);
    expect(html).not.toContain('data-testid="rows"');
    expect(html).not.toContain(ACCESS_TITLE);
    expect(html).not.toContain(RETRY);
    expect(html).not.toContain('role="status"');
  });

  it('3c) normal (rows) → children rendered, no empty/error/access-denied copy', () => {
    const html = render({ itemCount: 1 });
    expect(html).toContain('data-testid="rows"');
    expect(html).toContain('row-1');
    expect(html).not.toContain(EMPTY);
    expect(html).not.toContain(ACCESS_TITLE);
    expect(html).not.toContain(RETRY);
  });

  it('3d) loading takes precedence even when isError+forbidden are also set', () => {
    // Guards the branch ordering: loading short-circuits before the error
    // branch, so a stale `error` never leaks the access-denied UI mid-load.
    const html = render({ isLoading: true, isError: true, error: forbidden() });
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain(ACCESS_TITLE);
  });
});

describe('§P4-#13 / isPermissionDenied — purity matrix (no over-matching, no duck-typing)', () => {
  it('4a) TRUE only for ApiClientError with code exactly "forbidden"', () => {
    expect(isPermissionDenied(new ApiClientError({ code: 'forbidden' }))).toBe(true);
  });

  it('4b) FALSE for ApiClientError code:not_found (a 404 must not look like a 403)', () => {
    expect(isPermissionDenied(new ApiClientError({ code: 'not_found' }))).toBe(false);
  });

  it('4c) FALSE for ApiClientError code:internal (a 500 must not look like a 403)', () => {
    expect(isPermissionDenied(new ApiClientError({ code: 'internal' }))).toBe(false);
  });

  it('4d) FALSE for a plain Error', () => {
    expect(isPermissionDenied(new Error('forbidden'))).toBe(false);
  });

  it('4e) FALSE for null / undefined', () => {
    expect(isPermissionDenied(null)).toBe(false);
    expect(isPermissionDenied(undefined)).toBe(false);
  });

  it('4f) FALSE for a string "forbidden"', () => {
    expect(isPermissionDenied('forbidden')).toBe(false);
  });

  it('4g) FALSE for a duck-typed POJO {code:"forbidden"} that is NOT an ApiClientError', () => {
    // The whole point of the instanceof guard: an attacker-controlled or
    // adapter-mangled object that merely *has* the field must not be
    // mistaken for a real permission denial.
    expect(isPermissionDenied({ code: 'forbidden' })).toBe(false);
    expect(isPermissionDenied({ code: 'forbidden', message: 'x', name: 'ApiClientError' })).toBe(
      false,
    );
  });

  it('4h) FALSE for case / whitespace variants (exact match only)', () => {
    expect(isPermissionDenied(new ApiClientError({ code: 'Forbidden' }))).toBe(false);
    expect(isPermissionDenied(new ApiClientError({ code: ' forbidden ' }))).toBe(false);
    expect(isPermissionDenied(new ApiClientError({ code: 'forbidden_extra' }))).toBe(false);
  });
});

describe('§P4-#13 / non-tautology proof', () => {
  it('5) the pre-fix shell (error branch ALWAYS = generic retryable banner) FAILS test 1', () => {
    // Simulate the world before the fix: render a shell whose error branch is
    // the OLD generic retryable banner regardless of the error code. We do
    // this by rendering a tiny stand-in with exactly the pre-fix markup, then
    // asserting that test 1's invariant (access-denied copy + role=status,
    // NO button) does NOT hold — proving test 1 actually discriminates the
    // new behaviour and isn't a tautology that would pass on the old code.
    const preFixHtml = renderToStaticMarkup(
      createElement(
        'div',
        { className: 'space-y-3' },
        createElement('p', { className: 'text-sm text-destructive' }, LOAD_FAILED),
        createElement('button', null, RETRY),
      ),
    );

    // In the pre-fix world the access-denied invariant is violated:
    const preFixHasAccessDenied =
      preFixHtml.includes('role="status"') && preFixHtml.includes(ACCESS_TITLE);
    const preFixHasNoButton = !preFixHtml.includes('<button');

    expect(preFixHasAccessDenied).toBe(false); // no access-denied state existed
    expect(preFixHasNoButton).toBe(false); // a retry button was always present

    // And the post-fix shell DOES satisfy it — the discriminating contrast.
    const postFixHtml = render({ isError: true, error: forbidden() });
    expect(postFixHtml.includes('role="status"') && postFixHtml.includes(ACCESS_TITLE)).toBe(true);
    expect(postFixHtml.includes('<button')).toBe(false);
  });
});
