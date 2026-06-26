/**
 * 0.S6 (#38 same-class fix) — ShareActivityPanel forwards the REAL query error
 * to <DataState> so a 403/forbidden renders the legible access-denied panel,
 * NOT the generic retry treatment.
 *
 * Regression guard for the hard-coded `error={undefined}` defect: <DataState>
 * derives its forbidden branch from a real `ApiClientError(code:'forbidden')`
 * via `isPermissionDenied`. If the panel passes `undefined`, a 403 falls
 * through to the generic retryable error copy — wrong for a permission denial.
 *
 * The repo's vitest env is `node` (no DOM), so the REAL `<ShareActivityPanel>`
 * is rendered via `react-dom/server` (`renderToStaticMarkup` → HTML string).
 * The list hook is stubbed per test; next-intl resolves the REAL he.json keys
 * for the `dataState` namespace (the panel itself uses `externalShare`).
 * `<DataState>` is the REAL primitive (not stubbed) — that IS what we verify.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/lib/api/errors';
import heMessages from '@/messages/he.json';

// ─── next-intl: resolve REAL he.json keys (dotted) for any namespace ─────────
const messages = heMessages as Record<string, Record<string, unknown>>;
function makeResolver(ns: string) {
  return (key: string): string => {
    const parts = key.split('.');
    let node: unknown = messages[ns];
    for (const p of parts) {
      if (node && typeof node === 'object' && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return `MISSING:${ns}.${key}`;
      }
    }
    return typeof node === 'string' ? node : `MISSING:${ns}.${key}`;
  };
}
vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => makeResolver(ns),
}));
const tDataState = makeResolver('dataState');

// The list hook — controllable per test. Default: a successful empty load.
const listState = {
  data: { items: [] as unknown[], page: { limit: 50, cursor: null, has_more: false } },
  isLoading: false,
  isError: false,
  error: undefined as unknown,
  refetch: () => {},
};
vi.mock('@/hooks/external-share-list', () => ({
  useExternalShareList: () => listState,
}));

import { ShareActivityPanel } from './share-activity-panel';

afterEach(() => {
  listState.data = { items: [], page: { limit: 50, cursor: null, has_more: false } };
  listState.isLoading = false;
  listState.isError = false;
  listState.error = undefined;
  vi.clearAllMocks();
});

describe('ShareActivityPanel — error prop forwarding (#38 same-class)', () => {
  it('a 403 forbidden error renders the access-denied panel, NOT the generic retry', () => {
    listState.data = undefined as never;
    listState.isError = true;
    listState.error = new ApiClientError({ code: 'forbidden', message: 'forbidden' });

    const html = renderToStaticMarkup(createElement(ShareActivityPanel));

    // Access-denied (forbidden) copy IS shown — proves the real error reached
    // DataState and `isPermissionDenied` matched.
    expect(html).toContain(tDataState('forbiddenTitle'));
    expect(html).toContain(tDataState('forbiddenBody'));
    // The generic retryable-error copy + the retry affordance are NOT shown.
    expect(html).not.toContain(tDataState('errorTitle'));
    expect(html).not.toContain(tDataState('retry'));
    expect(html).not.toContain('MISSING:');
  });

  it('a non-permission (network/5xx) error keeps the generic retryable treatment', () => {
    listState.data = undefined as never;
    listState.isError = true;
    listState.error = new ApiClientError({ code: 'invalid_response', message: 'boom' });

    const html = renderToStaticMarkup(createElement(ShareActivityPanel));

    // A generic error is NOT a permission denial → retryable error treatment.
    expect(html).toContain(tDataState('errorTitle'));
    expect(html).toContain(tDataState('retry'));
    expect(html).not.toContain(tDataState('forbiddenTitle'));
    expect(html).not.toContain('MISSING:');
  });
});
