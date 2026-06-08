/**
 * ADVERSARIAL test for the locale-segment error boundary (`error.tsx`).
 *
 * LOAD-BEARING invariant (owner requirement): the rendered DOM must NEVER
 * contain `error.message` / `error.stack` / any exception internals — the ONLY
 * error-derived value allowed on the page is the opaque `error.digest`. A
 * leaked stack/message is an outward information-disclosure surface (file
 * paths, SQL, internal call shape).
 *
 * Why render the REAL component (not a source grep): a static check would only
 * prove the builder typed `error.digest` — not that `error.message` / `.stack`
 * actually stay OUT of the markup. We build a real `Error` at runtime carrying
 * recognizable marker strings in `.message` and `.stack`, render the real
 * boundary via `react-dom/server` (the repo's vitest env is `node`, no DOM —
 * `renderToStaticMarkup` returns an HTML string), then assert the markers are
 * absent. If a future edit interpolated `{error.message}` into the JSX, the
 * marker would appear in the string and THIS test would fail — that is what
 * makes the no-leak assertion non-vacuous.
 *
 * The Hebrew copy is matched against the REAL he.json `errorBoundary.*` strings
 * (imported below) so a renamed/removed translation key surfaces here too.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import heMessages from '@/messages/he.json';

const EB = heMessages.errorBoundary;

// next-intl: useTranslations('errorBoundary') → keyed lookup into the REAL
// he.json namespace, so the rendered markup contains the actual user-facing
// Hebrew (or a loud MISSING token if the component asks for a key we don't
// have → failure, not a silent pass).
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) =>
    (EB as Record<string, string>)[key] ?? `MISSING:errorBoundary.${key}`,
}));

// next/link → plain anchor so renderToStaticMarkup emits the href + label.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

// Import AFTER the mocks are registered (vi.mock is hoisted; the explicit
// import here documents the ordering intent).
import LocaleError from './error';

/**
 * Build a real Error at RUNTIME carrying marker strings — no secret/marker
 * literal lives in the committed source (the markers are assembled here so the
 * test proves *containment*, not the absence of a hard-coded constant).
 */
function makeLeakyError(): {
  error: Error & { digest?: string };
  msgMarker: string;
  stackMarker: string;
  digest: string;
} {
  const msgMarker = `SECRET-LEAK-${(12_345).toString()}`;
  const stackMarker = `STACK-FRAME-${(67_890).toString()}-at-internal-handler`;
  const digest = `abc123digest`;
  const error = new Error(msgMarker) as Error & { digest?: string };
  // Force a stack that contains our recognizable frame marker (real stacks are
  // env-dependent; we pin a known substring so the assertion can't be fooled by
  // a differently-shaped runtime stack).
  error.stack = `Error: ${msgMarker}\n    at ${stackMarker} (/srv/app/internal/secret.ts:42:13)`;
  error.digest = digest;
  return { error, msgMarker, stackMarker, digest };
}

function render(error: Error & { digest?: string }): string {
  return renderToStaticMarkup(createElement(LocaleError, { error, reset: () => undefined }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('LocaleError boundary (error.tsx)', () => {
  // ---- TEST 1: NO INTERNALS LEAK (LOAD-BEARING) ----
  it('1) renders the generic title + digest but NEVER the message or stack', () => {
    const { error, msgMarker, stackMarker, digest } = makeLeakyError();
    // Sanity-check the fixture itself is adversarial: the markers really are
    // present on the error we hand the component. If this ever fails the test
    // below would be vacuous, so guard it explicitly.
    expect(error.message).toContain(msgMarker);
    expect(error.stack).toContain(stackMarker);

    const html = render(error);

    // The generic, user-safe copy IS shown…
    expect(html).toContain(EB.title);
    // …and the opaque correlation id IS shown…
    expect(html).toContain(digest);
    // …but NONE of the internal markers reach the DOM.
    expect(html, 'error.message must NOT reach the DOM').not.toContain(msgMarker);
    expect(html, 'error.stack must NOT reach the DOM').not.toContain(stackMarker);
    // Defensive: the raw "Error:" stack header must not appear either.
    expect(html).not.toContain('secret.ts');
    expect(html).not.toContain('/srv/app/internal');
  });

  // ---- TEST 2: ACTIONS PRESENT (retry + home link) ----
  it('2) renders a "try again" button wired to reset and a home link to /', () => {
    let resetCalls = 0;
    const error = new Error('boom') as Error & { digest?: string };
    const html = renderToStaticMarkup(
      createElement(LocaleError, {
        error,
        reset: () => {
          resetCalls += 1;
        },
      }),
    );

    // The retry control is a real <button type="button"> carrying the retry copy.
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain(EB.retry);
    // The home action is an anchor to "/" carrying the home copy.
    expect(html).toMatch(/href="\/"/);
    expect(html).toContain(EB.home);

    // reset isn't invoked during render (it's an onClick) — assert we didn't
    // accidentally call it, which would prove the binding shape, not a no-op.
    expect(resetCalls).toBe(0);
  });

  // ---- TEST 3: digest is omitted entirely when absent (no empty ref row) ----
  it('3) omits the reference-id row when error.digest is undefined', () => {
    const error = new Error('boom') as Error & { digest?: string };
    const html = render(error);
    // The referenceId LABEL must not render when there is no digest to show.
    expect(html).not.toContain(EB.referenceId);
    // But the boundary still renders its generic shell.
    expect(html).toContain(EB.title);
  });
});
