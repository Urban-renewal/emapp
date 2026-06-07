/**
 * P4 #8 — ADVERSARIAL spec for the resident DEAD-LINK RECOVERY CTA on the
 * public signing page (`apps/web/src/app/sign/[token]/page.tsx`).
 *
 * What the builder added (in the `stage === 'invalid'` render block):
 *  - a generic recovery hint (`sign.invalidRecoveryHint`),
 *  - a primary recovery CTA <Link href="/he/tenant/login"> (`sign.invalidRecoveryCta`),
 *  - a secondary "contact your manager" line (`sign.invalidContactManager`).
 *
 * The load-bearing invariant is ANTI-ENUMERATION (D.12 LAW posture mirrored
 * on the FE): every token failure — expired / cancelled / revoked / forged /
 * already-signed — collapses to ONE identical screen. The recovery copy must
 * therefore reveal NOTHING about WHY the token failed, and the CTA must point
 * residents at the SELF-SERVICE recovery path (tenant portal login), not at a
 * dead `#`, not at the org login, not back at /sign.
 *
 * --------------------------------------------------------------------------
 * Test harness (mirrors sidebar.spec.ts / list-page-shell.spec.ts):
 *
 * The repo's vitest env is `node` with NO jsdom / testing-library and the
 * glob is `src/**\/*.spec.ts` (NOT `.spec.tsx`), so JSX cannot appear here —
 * esbuild parses `.ts` as TS. We render the REAL SignPage component to an
 * HTML string via `react-dom/server`'s `renderToStaticMarkup` (no JSX, only
 * `createElement`) and assert on concrete rendered markup + the real he.json
 * copy strings.
 *
 * To drive the component to a chosen `stage` deterministically we replace
 * React's `useState` with an order-indexed queue: SignPage calls useState in
 * a fixed order
 *     [0] stage   [1] preview   [2] doneAt   [3] submitError   [4] canvasEmpty
 * and `seedState()` lets each test seed the slots it cares about (stage +
 * preview/doneAt as needed). `useEffect` is stubbed to a no-op so the real
 * fetch loader never runs and never overwrites the seeded stage. Everything
 * else (useRef/useCallback/useState plumbing) passes through to real React.
 * --------------------------------------------------------------------------
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real shipped copy — loaded so the anti-enumeration word-check (Test 2) runs
// against the ACTUAL strings residents see, not the spec's COPY constants. A
// reason word added to either locale's recovery copy fails the build here.
import enMessages from '@/messages/en.json';
import heMessages from '@/messages/he.json';

// ---- Real he.json `sign.*` copy (the rendered text we assert on). Kept in
//      sync with src/messages/he.json; drift here is intentional signal. ----
const COPY = {
  invalidTitle: 'הקישור אינו תקף',
  invalidBody:
    'הקישור לחתימה אינו זמין יותר. ייתכן שהוא פג תוקף, כבר נחתם או בוטל. צור קשר עם מנהל הפרויקט לקבלת קישור חדש.',
  invalidRecoveryHint: 'ניתן להתחבר לפורטל הדיירים ולשלוח לעצמך קישור חתימה חדש.',
  invalidRecoveryCta: 'התחבר לפורטל לקבלת קישור חדש',
  invalidContactManager: 'אם אינך מצליח להתחבר, פנה למנהל הפרויקט.',
  doneTitle: 'החתימה נקלטה בהצלחה ✓',
  doneBody: 'תודה. החתימה נשמרה במערכת. ניתן לסגור את החלון.',
  pageTitle: 'חתימה על מסמך',
  loading: 'טוען...',
} as const;

// next-intl: useTranslations('sign') → keyed lookup into COPY. A key the
// component asks for that we don't model surfaces as a loud MISSING:<key>
// token in the markup (not a silent pass). `t.rich` is provided because the
// preview stage calls it; it returns a plain marker (preview stage isn't the
// subject under test, but it must render without throwing).
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

// next/link → plain anchor so renderToStaticMarkup emits href + label.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

// useParams → a present token (the loader is stubbed out anyway, but a
// non-empty token avoids the `!token → invalid` short-circuit being the
// reason `invalid` rendered; we control stage via the useState queue).
vi.mock('next/navigation', () => ({
  useParams: () => ({ token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' }),
}));

// NameDisplay is a bdi wrapper; passthrough so the preview stage renders.
vi.mock('@/components/ui/name-display', () => ({
  NameDisplay: ({ name }: { name: string }) => createElement('span', null, name),
}));

// SignatureCanvas pulls in browser-only canvas machinery; stub to an inert
// marker so the preview stage renders in the node env without throwing.
vi.mock('./_signature-canvas', () => ({
  SignatureCanvas: () => createElement('div', { 'data-testid': 'canvas-stub' }),
}));

// --- useState queue: drive `stage` (and friends) deterministically. ---
// SignPage calls useState in this fixed order; seed the slots per test.
let stateQueue: unknown[] = [];

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  let callIndex = 0;
  return {
    ...actual,
    // Order-indexed seeding. SignPage calls useState exactly `stateQueue.length`
    // (5) times per render, in a fixed order, BEFORE any early return — so the
    // cursor wraps cleanly at the queue boundary, auto-resetting for the next
    // render. No external reset hook needed (keeps the import block clean).
    useState: (initial: unknown) => {
      if (stateQueue.length > 0 && callIndex >= stateQueue.length) callIndex = 0;
      const idx = callIndex;
      callIndex += 1;
      const seeded = stateQueue.length > 0 && idx < stateQueue.length ? stateQueue[idx] : initial;
      const setter = vi.fn();
      return [seeded, setter];
    },
    // No-op the loader effect so it never overwrites the seeded stage.
    useEffect: () => undefined,
  };
});

// Import AFTER mocks (vi.mock is hoisted; explicit import documents ordering).
import SignPage from './page';

/** Seed the useState queue and render the REAL SignPage to an HTML string. */
function renderStage(states: {
  stage: 'loading' | 'preview' | 'submitting' | 'done' | 'invalid';
  preview?: unknown;
  doneAt?: unknown;
}): string {
  // Slot order: [0]stage [1]preview [2]doneAt [3]submitError [4]canvasEmpty
  stateQueue = [
    states.stage,
    states.preview ?? null,
    states.doneAt ?? null,
    null, // submitError
    true, // canvasEmpty
  ];
  return renderToStaticMarkup(createElement(SignPage));
}

const VALID_PREVIEW = {
  document: { name: 'הסכם תמ"א 38', downloadUrl: 'https://r2.example.com/doc.pdf' },
  owner: { name: 'דנה כהן' },
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
};

const DONE_AT = { signedAt: new Date().toISOString() };

// The recovery link target — the ONLY correct destination.
const PORTAL_LOGIN_HREF = '/he/tenant/login';

/** True iff the rendered HTML contains the recovery CTA — matched BOTH by the
 *  CTA label AND the portal-login href so a partial render can't fool us. */
function hasRecoveryCta(html: string): boolean {
  return html.includes(COPY.invalidRecoveryCta) && html.includes(`href="${PORTAL_LOGIN_HREF}"`);
}

beforeEach(() => {
  stateQueue = [];
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('P4 #8 / sign page — dead-link recovery CTA (invalid state)', () => {
  // ---- TEST 1: the CTA + hint + contact-manager line render in `invalid`. ----
  it('1) renders recovery hint + portal-login CTA + contact-manager line in the invalid state', () => {
    const html = renderStage({ stage: 'invalid' });

    // The generic dead-link framing is present...
    expect(html).toContain(COPY.invalidTitle);

    // ...the recovery hint copy...
    expect(html).toContain(COPY.invalidRecoveryHint);

    // ...the primary recovery CTA: BOTH the label AND a real anchor to the
    // tenant portal login.
    expect(html).toContain(COPY.invalidRecoveryCta);
    expect(html).toMatch(/<a\s[^>]*href="\/he\/tenant\/login"/);

    // ...and the secondary contact-manager line.
    expect(html).toContain(COPY.invalidContactManager);

    // Composite guard.
    expect(hasRecoveryCta(html)).toBe(true);
  });

  // ---- TEST 2 (LOAD-BEARING): anti-enumeration — the RECOVERY additions
  //      reveal nothing about WHY the token failed, and carry no PII. ----
  it('2) anti-enumeration: recovery copy is generic — no reason word, no PII', () => {
    const html = renderStage({ stage: 'invalid' });

    // Adversarial grep over the ACTUAL rendered invalid-state HTML — but with
    // the pre-existing `invalidBody` umbrella sentence carved out (see NOTE
    // below). What remains is the recovery affordance the builder added plus
    // the generic title; NONE of it may disclose the failure cause.
    expect(html, 'sanity: invalidBody umbrella sentence must be present').toContain(
      COPY.invalidBody,
    );
    const htmlSansUmbrella = html.split(COPY.invalidBody).join('');

    // Reason-revealing words (he + en) that would let an attacker distinguish
    // expired vs cancelled vs revoked vs already-signed vs forged. NONE may
    // appear in the rendered HTML once the safe umbrella sentence is removed.
    const FORBIDDEN_REASON_WORDS = [
      // English
      'expired',
      'expir',
      'cancel',
      'revok',
      'forg',
      'already signed',
      'already been signed',
      'invalid token',
      'not found',
      // Hebrew
      'פג תוקף',
      'פג-תוקף',
      'בוטל',
      'בוטלה',
      'נחתם',
      'כבר נחתם',
      'מזויף',
      'לא נמצא',
    ];
    for (const word of FORBIDDEN_REASON_WORDS) {
      expect(
        htmlSansUmbrella.toLowerCase().includes(word.toLowerCase()),
        `invalid-state HTML LEAKS the failure reason "${word}" outside the safe umbrella sentence — anti-enumeration breach`,
      ).toBe(false);
    }

    // SECOND, AND LOAD-BEARING: grep the REAL shipped he/en `sign.*` recovery
    // copy (not the spec's COPY mirror) so a reason word smuggled into either
    // locale's recovery strings fails CI even though the page mock returns a
    // stub. These three keys are EXACTLY what the builder added.
    const RECOVERY_KEYS = [
      'invalidRecoveryHint',
      'invalidRecoveryCta',
      'invalidContactManager',
    ] as const;
    const heSign = (heMessages as { sign: Record<string, string> }).sign;
    const enSign = (enMessages as { sign: Record<string, string> }).sign;
    for (const key of RECOVERY_KEYS) {
      const heVal = heSign[key];
      const enVal = enSign[key];
      expect(heVal, `he.json sign.${key} must exist`).toBeTruthy();
      expect(enVal, `en.json sign.${key} must exist`).toBeTruthy();
      for (const word of FORBIDDEN_REASON_WORDS) {
        expect(
          `${heVal} ${enVal}`.toLowerCase().includes(word.toLowerCase()),
          `shipped recovery copy sign.${key} LEAKS the failure reason "${word}" — anti-enumeration breach`,
        ).toBe(false);
      }
    }

    // No PII / token material anywhere in the rendered invalid screen: no
    // national-id-ish digit runs, no owner name, no JWT-looking dotted base64,
    // and not the raw token from useParams.
    expect(html).not.toMatch(/\d{9}/); // national_id shape
    expect(html).not.toContain('דנה כהן'); // a sample owner name
    expect(html).not.toMatch(/eyJ[A-Za-z0-9_-]+\./); // JWT prefix
    expect(html).not.toContain('eyJhbGciOiJIUzI1NiJ9'); // the mocked token

    /*
     * NOTE — pre-existing `invalidBody` copy (NOT added by this builder):
     *   "...ייתכן שהוא פג תוקף, כבר נחתם או בוטל..."
     *   "...It may have expired, been signed, or been cancelled..."
     * This lists ALL possibilities at once, which is the CANONICAL anti-
     * enumeration pattern: the SAME constant sentence renders for every
     * failure cause, so it discloses nothing about which one applies. It is
     * therefore SAFE and we do NOT forbid those words in `invalidBody`. The
     * security property is INVARIANCE (identical screen for every reason),
     * proved by TEST 5 below — not word-absence in the umbrella sentence.
     * Test 2 scopes word-absence to the recovery affordance the builder added.
     */
  });

  // ---- TEST 3: the CTA is ABSENT in every non-invalid stage. ----
  it('3a) preview (valid) stage: NO recovery CTA / portal-login link', () => {
    const html = renderStage({ stage: 'preview', preview: VALID_PREVIEW });

    // Sanity: we really are on the preview stage (page title renders).
    expect(html).toContain(COPY.pageTitle);

    // The recovery affordance belongs ONLY to the dead-link screen.
    expect(html).not.toContain(COPY.invalidRecoveryCta);
    expect(html).not.toContain(COPY.invalidRecoveryHint);
    expect(html).not.toContain(`href="${PORTAL_LOGIN_HREF}"`);
    expect(hasRecoveryCta(html)).toBe(false);
  });

  it('3b) done (success) stage: NO recovery CTA / portal-login link', () => {
    const html = renderStage({ stage: 'done', doneAt: DONE_AT });

    // Sanity: success copy renders.
    expect(html).toContain(COPY.doneTitle);

    expect(html).not.toContain(COPY.invalidRecoveryCta);
    expect(html).not.toContain(COPY.invalidRecoveryHint);
    expect(html).not.toContain(`href="${PORTAL_LOGIN_HREF}"`);
    expect(hasRecoveryCta(html)).toBe(false);
  });

  it('3c) loading stage: NO recovery CTA', () => {
    const html = renderStage({ stage: 'loading' });
    expect(html).toContain(COPY.loading);
    expect(html).not.toContain(COPY.invalidRecoveryCta);
    expect(html).not.toContain(`href="${PORTAL_LOGIN_HREF}"`);
  });

  // ---- TEST 4: link-target correctness — it points at the tenant portal
  //      login, NOT /sign, NOT an org login, NOT a dead `#`. ----
  it('4) recovery link target is exactly the tenant portal login (no wrong/dead target)', () => {
    const html = renderStage({ stage: 'invalid' });

    // Exactly the portal login.
    expect(html).toMatch(/<a\s[^>]*href="\/he\/tenant\/login"/);

    // Extract the href of the anchor that wraps the CTA label and assert it.
    const anchorMatch = html.match(/<a\s[^>]*href="([^"]+)"[^>]*>[^<]*התחבר לפורטל/);
    expect(anchorMatch, 'CTA anchor must be present with an href').not.toBeNull();
    const href = anchorMatch?.[1];
    expect(href).toBe(PORTAL_LOGIN_HREF);

    // Negative targets — none of these wrong/dead destinations may be the CTA.
    expect(href).not.toBe('#');
    expect(href).not.toBe('');
    expect(href).not.toMatch(/^\/sign/); // not back to the dead signing route
    expect(href).not.toContain('/api/'); // not an API endpoint
    // Not the ORG login (org login is locale-root `/he/login` with NO
    // `/tenant/` segment; the resident recovery path MUST be the tenant one).
    expect(href).toContain('/tenant/');
    expect(href).not.toMatch(/^\/(he|en)\/login$/);
  });

  // ---- TEST 5: anti-enumeration INVARIANCE (non-tautology proof). The
  //      `invalid` screen is byte-identical regardless of which failure
  //      reason drove it — there is no per-reason branch on the FE. ----
  it('5) the invalid screen is IDENTICAL across failure causes (invariance proof)', () => {
    // The FE only knows ONE thing: stage === 'invalid'. It has no reason
    // input. Rendering twice (as two independent failures would) yields the
    // exact same markup → an attacker cannot distinguish causes.
    const a = renderStage({ stage: 'invalid' });
    const b = renderStage({ stage: 'invalid', preview: VALID_PREVIEW, doneAt: DONE_AT });
    // Even when stale preview/doneAt state happens to be present, the invalid
    // branch short-circuits before they're read → identical output.
    expect(a).toBe(b);

    // And that identical screen carries the recovery affordance.
    expect(hasRecoveryCta(a)).toBe(true);
    // ...but NOT the valid-flow surface (no owner name / page title leak).
    expect(a).not.toContain('דנה כהן');
    expect(a).not.toContain(COPY.pageTitle);
  });
});
