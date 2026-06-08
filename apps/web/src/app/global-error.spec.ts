/**
 * ADVERSARIAL test for the ROOT error boundary (`global-error.tsx`).
 *
 * This boundary REPLACES the root layout when an error is thrown there, so it
 * must (a) emit its own `<html dir="rtl">…<body>` shell (Next requirement —
 * the locale layout has been torn down) and (b) it CANNOT use the NextIntl
 * provider, so it ships plain Hebrew literals.
 *
 * LOAD-BEARING invariant (identical to the locale boundary): the rendered DOM
 * must NEVER contain `error.message` / `error.stack` — only the opaque
 * `error.digest` may surface. We build a real Error at runtime with marker
 * strings and assert containment after a real `react-dom/server` render. A
 * future edit that interpolated `{error.message}` would surface the marker and
 * fail this test — that is what makes the no-leak assertion non-vacuous.
 *
 * The Hebrew copy here is matched against the literals the component renders
 * (it has no translation namespace) — kept as constants so a copy change is an
 * intentional, visible diff.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import GlobalError from './global-error';

// The plain Hebrew literals the root shell renders (no next-intl in scope).
const TITLE = 'משהו השתבש';
const HOME_COPY = 'חזרה לדף הבית';
const RETRY_COPY = 'נסה שוב';

function makeLeakyError(): {
  error: Error & { digest?: string };
  msgMarker: string;
  stackMarker: string;
  digest: string;
} {
  const msgMarker = `SECRET-LEAK-${(54_321).toString()}`;
  const stackMarker = `STACK-FRAME-${(98_760).toString()}-root-layout-boom`;
  const digest = `root987digest`;
  const error = new Error(msgMarker) as Error & { digest?: string };
  error.stack = `Error: ${msgMarker}\n    at ${stackMarker} (/srv/app/root-layout.tsx:7:1)`;
  error.digest = digest;
  return { error, msgMarker, stackMarker, digest };
}

function render(error: Error & { digest?: string }): string {
  return renderToStaticMarkup(createElement(GlobalError, { error, reset: () => undefined }));
}

describe('GlobalError boundary (global-error.tsx)', () => {
  // ---- TEST 1: root shell — own <html dir="rtl"> + generic copy ----
  it('1) renders its own <html dir="rtl"> shell with the generic Hebrew copy', () => {
    const error = new Error('boom') as Error & { digest?: string };
    const html = render(error);
    // Emits its OWN html root (Next requirement when replacing the layout)…
    expect(html).toMatch(/<html[^>]*dir="rtl"/);
    expect(html).toMatch(/<html[^>]*lang="he"/);
    // …and a <body>.
    expect(html).toMatch(/<body/);
    // The generic title + the two actions render.
    expect(html).toContain(TITLE);
    expect(html).toContain(RETRY_COPY);
    expect(html).toContain(HOME_COPY);
    expect(html).toMatch(/href="\/"/);
    expect(html).toMatch(/<button[^>]*type="button"/);
  });

  // ---- TEST 2: NO INTERNALS LEAK (LOAD-BEARING) ----
  it('2) shows the digest but NEVER the message or stack', () => {
    const { error, msgMarker, stackMarker, digest } = makeLeakyError();
    // Sanity: the fixture really carries the markers (guards against a vacuous
    // assertion if the Error shape ever changes).
    expect(error.message).toContain(msgMarker);
    expect(error.stack).toContain(stackMarker);

    const html = render(error);

    expect(html).toContain(TITLE);
    expect(html).toContain(digest);
    expect(html, 'error.message must NOT reach the DOM').not.toContain(msgMarker);
    expect(html, 'error.stack must NOT reach the DOM').not.toContain(stackMarker);
    expect(html).not.toContain('root-layout.tsx');
    expect(html).not.toContain('/srv/app');
  });
});
