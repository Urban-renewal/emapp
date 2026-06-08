/**
 * Public self-service signup gate — FE render test for the LOGIN page.
 *
 * Public self-service signup is INACTIVE by default (owner-approved, refines
 * D.21 — the active onboarding path is provider-led). The login page hides the
 * "create account" link unless `NEXT_PUBLIC_SIGNUP_ENABLED === '1'`, mirroring
 * the server-side `PUBLIC_SIGNUP_ENABLED` flag (POST /auth/signup → 404 while
 * off). See docs/decision-records/disable-public-signup.md.
 *
 * Why render the REAL component (not a source grep): the gate is a
 * `{SIGNUP_ENABLED && (<Link href="/signup">…)}` JSX conditional. A source
 * check would assert the builder typed a token, not that the link is actually
 * absent. The repo vitest env is `node` (no jsdom) so we render the real
 * `LoginPage` via `react-dom/server` `renderToStaticMarkup` (the same pattern
 * as sidebar.spec.ts) and assert the `/signup` anchor is ABSENT in the
 * default-off markup and PRESENT once the flag is '1'.
 *
 * Mutation check: delete the `{SIGNUP_ENABLED && …}` gate (render the link
 * unconditionally) and the default-OFF test FAILS (the /signup link appears).
 *
 * `NEXT_PUBLIC_SIGNUP_ENABLED` is inlined at module-eval time, so the ON case
 * uses `vi.resetModules()` + a fresh dynamic import with the env set, then
 * restores it — proving the gate is reversible, not a constant hide.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// next-intl: echo the key back so the rendered markup is deterministic and we
// can assert on the signup CTA key without coupling to he.json copy.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'he',
}));

// next/link → plain anchor so renderToStaticMarkup emits the href.
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));

// next/navigation — useRouter is called at render; stub it.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  redirect: vi.fn(),
}));

// api-client / errors are only referenced inside the submit handler (not at
// render time) but must resolve as modules.
vi.mock('@/lib/api-client', () => ({
  apiClient: { post: vi.fn() },
  isOk: () => false,
}));
vi.mock('@/lib/errors', () => ({ applyValidationErrors: () => [] }));

async function renderLogin(): Promise<string> {
  // Fresh import each call so the module-level SIGNUP_ENABLED is re-evaluated
  // against the CURRENT process.env.
  vi.resetModules();
  const mod = await import('./page');
  return renderToStaticMarkup(createElement(mod.default));
}

const FLAG = 'NEXT_PUBLIC_SIGNUP_ENABLED';

describe('LoginPage — NEXT_PUBLIC_SIGNUP_ENABLED gate', () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[FLAG];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
    vi.resetModules();
  });

  it('default (flag unset) → renders the login form but NO /signup link', async () => {
    delete process.env[FLAG];
    const html = await renderLogin();
    // Sanity: this really is the login form (gate did not blank the page).
    expect(html).toContain('loginCta');
    // The gate: no signup entry point.
    expect(html).not.toContain('href="/signup"');
    expect(html).not.toContain('>signup<');
    expect(html).not.toContain('noAccount');
  });

  it('flag="0" → still no /signup link (strict equality to "1")', async () => {
    process.env[FLAG] = '0';
    const html = await renderLogin();
    expect(html).not.toContain('href="/signup"');
  });

  it('flag="1" → the /signup link IS rendered (gate is reversible)', async () => {
    process.env[FLAG] = '1';
    const html = await renderLogin();
    expect(html).toContain('href="/signup"');
    expect(html).toContain('noAccount');
  });
});
