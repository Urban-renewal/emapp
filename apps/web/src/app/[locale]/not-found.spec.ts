/**
 * Test for the locale-segment 404 page (`not-found.tsx`).
 *
 * A 404 carries no exception, so "no internals leak" holds by construction —
 * this spec proves the branded copy + home link render (so a missing page
 * looks intentional, not like the default Next.js 404) AND that nothing that
 * looks like an error stack/message snuck in.
 *
 * Copy is matched against the REAL he.json `notFoundPage.*` strings so a
 * renamed/removed key surfaces here.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import heMessages from '@/messages/he.json';

const NF = heMessages.notFoundPage;

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) =>
    (NF as Record<string, string>)[key] ?? `MISSING:notFoundPage.${key}`,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

import NotFound from './not-found';

function render(): string {
  return renderToStaticMarkup(createElement(NotFound));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('NotFound page (not-found.tsx)', () => {
  it('1) renders the 404 copy + a home link to /', () => {
    const html = render();
    // The big 404 marker.
    expect(html).toContain('404');
    // The branded Hebrew copy (real he.json keys).
    expect(html).toContain(NF.title);
    expect(html).toContain(NF.description);
    // A single home link to "/".
    expect(html).toContain(NF.home);
    expect(html).toMatch(/href="\/"/);
    // No MISSING token leaked (would mean a translation key drifted).
    expect(html).not.toContain('MISSING:');
  });

  it('2) carries no error internals by construction (no stack/digest surface)', () => {
    const html = render();
    // Defensive: a 404 must not accidentally render anything error-shaped.
    expect(html.toLowerCase()).not.toContain('stack');
    expect(html.toLowerCase()).not.toContain('digest');
    expect(html).not.toMatch(/Error:/);
  });
});
