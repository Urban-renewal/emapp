/**
 * Test for the ROOT 404 page (`not-found.tsx`).
 *
 * Renders for URLs that match NO route at all (outside the locale tree / dotted
 * paths that skip the middleware). Like `global-error.tsx`, it renders OUTSIDE
 * the NextIntl provider, so it MUST emit its own `<html dir="rtl">…<body>`
 * shell and ship plain Hebrew literals (S-1 — replaces Next's default English
 * "This page could not be found").
 *
 * Hebrew copy is asserted as constants so a wording change is an intentional,
 * visible diff.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import RootNotFound from './not-found';

const TITLE = 'הדף לא נמצא';
const HOME_COPY = 'חזרה לדף הבית';

function render(): string {
  return renderToStaticMarkup(createElement(RootNotFound));
}

describe('RootNotFound (not-found.tsx)', () => {
  it('emits its own <html lang="he" dir="rtl"> shell (outside the locale layout)', () => {
    const html = render();
    expect(html).toMatch(/<html[^>]*dir="rtl"/);
    expect(html).toMatch(/<html[^>]*lang="he"/);
    expect(html).toMatch(/<body/);
  });

  it('renders the branded Hebrew 404 copy (not the default English text)', () => {
    const html = render();
    expect(html).toContain('404');
    expect(html).toContain(TITLE);
    expect(html).not.toContain('This page could not be found');
  });

  it('offers a link back to the home page', () => {
    const html = render();
    expect(html).toContain(HOME_COPY);
    expect(html).toMatch(/href="\/"/);
  });
});
