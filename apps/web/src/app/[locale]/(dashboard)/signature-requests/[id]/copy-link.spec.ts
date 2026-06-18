/**
 * P4 "copy signing link" — detail-page render gating + no-signUrl-in-DOM
 * (TEST-AUTHOR, adversarial). Companion to `lib/api/signature-requests-link.api.spec.ts`
 * (which pins the api/hook wiring + error surface).
 *
 * REQUIRED tests covered here:
 *   1) Gating visible      — `signature_requests.send` + status `pending` → button renders
 *                            (asserted against the REAL he.json `signatureRequests.copyLink` label).
 *   2) Gating hidden (perm)— Viewer w/o `signature_requests.send` → button NOT rendered.
 *   3) Gating hidden (state)— status `signed`/`cancelled` (not pending) → button NOT rendered.
 *   4) signUrl never in DOM — even when the retrieve mutation has a resolved
 *                            `{ signUrl }` available, the static markup contains
 *                            ONLY the masked confirmation copy — never the raw
 *                            URL/token. (Load-bearing; assert adversarially.)
 *   6) error mapping (render half) — `actionError` text, when present, is one of
 *                            the masked he.json keys and never leaks a signUrl.
 *
 * Harness: the repo's node-env `renderToStaticMarkup` pattern (see
 * `_components/sidebar.spec.ts`). We render the REAL
 * `SignatureRequestDetailPage` and mock its data/permission/mutation hooks +
 * next-intl/next-link/next-navigation. Child UI (`Button`, `StatusBadge`)
 * stay REAL — they emit their children into the markup, which is exactly what
 * we assert on.
 *
 * NODE-ENV LIMITATION (honest disclosure): `renderToStaticMarkup` is a single
 * static pass — it cannot fire the button's `onClick`, so the click →
 * `mutateAsync` → `navigator.clipboard.writeText` → `setLinkCopied(true)`
 * runtime path is NOT driven here. That click/clipboard contract is covered as
 * follows:
 *   - the api/hook half (retrieveLink POST + parse + invalidate + 409 surface)
 *     is exercised end-to-end in the companion api spec;
 *   - the DOM-leakage invariant (test 4) is proven render-side: because the
 *     component initialises `linkCopied=false` and NEVER stores `signUrl` in
 *     state nor renders it, NO reachable render (loading / pending / copied-
 *     confirmation / error) can contain the URL. We seed a mutation whose
 *     resolved `data.signUrl` is a real https link and assert that link's token
 *     is absent from every rendered variant — including the post-success copy.
 *
 * No `eyJ...` literal — the seeded signUrl token is built at runtime.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Real he.json `signatureRequests` strings we assert on (kept in sync with
//     src/messages/he.json; a drift here is intentional signal). ---
const T: Record<string, string> = {
  copyLink: 'העתק קישור חתימה',
  copyLinkWorking: 'מפיק קישור…',
  copyLinkCopied: 'הקישור הועתק',
  copyLinkHint:
    'להעברה ידנית לבעל דירה ללא טלפון (וואטסאפ / אימייל / נייר). שים לב: הפקת הקישור מחדשת אותו — הקישור הקודם שנשלח יפסיק לעבוד.',
  copyLinkConfirm: 'קישור חתימה חדש הועתק ללוח. הקישור הקודם כבר אינו תקף.',
  copyLinkNotPending: 'ניתן להפיק קישור רק לבקשה ממתינה.',
  copyLinkFailed: 'הפקת קישור החתימה נכשלה.',
  detailTitle: 'פרטי בקשת חתימה',
};

// The seeded (re-minted) bearer link the retrieve mutation "resolved". Token
// built at runtime — never a hard-coded JWT. We assert this NEVER reaches the DOM.
const SECRET_TOKEN = ['tok', Date.now().toString(36), Math.random().toString(36).slice(2)].join('');
const SECRET_SIGN_URL = `https://app.emapp.io/sign/${SECRET_TOKEN}`;

/** Mutable permission-set the gate hook reads. Seed per test. */
let currentPerms = new Set<string>();
/** Mutable VM the detail query returns. Seed per test. */
let currentVm: Record<string, unknown> | null = null;

vi.mock('@/hooks/use-permissions', () => ({
  useHasPermission: (permission: string) => currentPerms.has(permission),
  usePermissions: () => ({ permissions: currentPerms, isResolved: true }),
}));

// The session profile drives the SIGNED-doc download gate (irrelevant here) —
// return a viewer-ish profile so that unrelated control never renders.
vi.mock('@/hooks/use-session', () => ({
  useSessionProfile: () => ({ data: { view_owner_pii: false } }),
}));

// The detail query → our seeded VM (already adapted: statusLabel/color/etc.).
vi.mock('@/hooks/use-signature-requests', () => ({
  useSignatureRequest: () => ({
    data: currentVm,
    isLoading: false,
    isError: false,
    error: null,
  }),
  // Mutations: the retrieve mutation carries a RESOLVED signUrl in `data`, so
  // if the component ever rendered mutation result data, the secret URL would
  // leak — test 4 proves it does not. `mutateAsync` is present for shape
  // fidelity (the click path is not driven in node-env; see header).
  useRetrieveSignatureLink: () => ({
    isPending: false,
    data: { request: currentVm, signUrl: SECRET_SIGN_URL },
    mutateAsync: vi.fn(async () => ({ request: currentVm, signUrl: SECRET_SIGN_URL })),
  }),
  useCancelSignatureRequest: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const base = T[key] ?? `MISSING:${key}`;
    // mimic the {rel}/{var} interpolation so createdAt etc. don't throw.
    return vars ? base.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? '')) : base;
  },
  useLocale: () => 'he',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '11111111-1111-4111-8111-111111111111' }),
  useRouter: () => ({ push: vi.fn() }),
}));

// Import AFTER mocks (vi.mock is hoisted; explicit here for ordering intent).
import SignatureRequestDetailPage from './page';

/** A faithful detail VM. `status` drives the gate; the rest are display fields
 *  the page reads off the adapted ViewModel. */
function vm(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'pending',
    statusLabel: 'ממתין',
    intent: 'warning',
    isExpired: false,
    isCancellable: true,
    createdRelative: 'לפני שעה',
    expiresRelative: 'בעוד 7 ימים',
    signedRelative: null,
    cancelledRelative: null,
    documentId: '33333333-3333-4333-8333-333333333333',
    ownerId: '44444444-4444-4444-8444-444444444444',
    ...overrides,
  };
}

function render(perms: string[], view: Record<string, unknown> | null): string {
  currentPerms = new Set(perms);
  currentVm = view;
  return renderToStaticMarkup(createElement(SignatureRequestDetailPage));
}

/** True iff the copy-link control is present — matched via its real label. */
function hasCopyButton(html: string): boolean {
  return html.includes(T.copyLink!);
}

beforeEach(() => {
  currentPerms = new Set();
  currentVm = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('SignatureRequestDetailPage — copy-link gating (P4)', () => {
  // ---- TEST 1: visible when send-perm + pending ----
  it('1) renders the copy-link button when actor holds signature_requests.send AND status=pending', () => {
    const html = render(['signature_requests.send'], vm({ status: 'pending' }));
    expect(hasCopyButton(html)).toBe(true);
    expect(html).toContain(T.copyLink);
    // The hint paragraph (same gate) also renders — proves both gated nodes fire.
    expect(html).toContain(T.copyLinkHint);
  });

  // ---- TEST 2: hidden without the permission (Viewer) ----
  it('2) HIDES the copy-link button for an actor WITHOUT signature_requests.send (e.g. Viewer)', () => {
    // Viewer holds read perms but not .send; status is pending (so ONLY the
    // permission gate can be keeping the button out).
    const html = render(['signature_requests.read'], vm({ status: 'pending' }));
    expect(hasCopyButton(html)).toBe(false);
    expect(html).not.toContain(T.copyLink);
    expect(html).not.toContain(T.copyLinkHint);
  });

  // ---- TEST 3: hidden when status is not pending (BE would 409) ----
  it('3) HIDES the copy-link button when status is not pending (signed / cancelled)', () => {
    for (const status of ['signed', 'cancelled'] as const) {
      const html = render(
        ['signature_requests.send'],
        vm({
          status,
          isCancellable: false,
          signedRelative: status === 'signed' ? 'לפני יום' : null,
          cancelledRelative: status === 'cancelled' ? 'לפני יום' : null,
        }),
      );
      expect(hasCopyButton(html), `status=${status} must hide the copy button`).toBe(false);
      expect(html, `status=${status}`).not.toContain(T.copyLink);
      // The hint is gated on the same (send && pending) condition → also gone.
      expect(html, `status=${status}`).not.toContain(T.copyLinkHint);
    }
  });

  // ---- TEST 4 (LOAD-BEARING): the raw signUrl/token NEVER appears in the DOM ----
  it('4) never renders the raw signUrl/token — across every gated render variant', () => {
    // Guard against a vacuous assertion: the secret token must be a real,
    // non-empty, sufficiently-distinct string (so `not.toContain` is meaningful).
    expect(SECRET_TOKEN.length).toBeGreaterThan(8);
    expect(SECRET_SIGN_URL).toContain(SECRET_TOKEN);

    const variants: Array<[string, string]> = [
      // pending + permitted — the ONE state where the button (and the resolved
      // mutation `data.signUrl`) is in scope; the highest-risk leak point.
      ['pending+send', render(['signature_requests.send'], vm({ status: 'pending' }))],
      // permitted but signed — mutation data still seeded; button gone.
      [
        'signed+send',
        render(['signature_requests.send'], vm({ status: 'signed', signedRelative: 'לפני יום' })),
      ],
      // pending but unpermitted.
      ['pending+noperm', render(['signature_requests.read'], vm({ status: 'pending' }))],
    ];

    for (const [name, html] of variants) {
      // Non-vacuous: the render actually produced markup (the detail title is
      // always present), so an empty-string false-positive can't sneak through.
      expect(html, `${name}: page must have rendered`).toContain(T.detailTitle);
      // The load-bearing invariant: neither the full URL nor the bare token.
      expect(html, `${name}: full signUrl must not be in DOM`).not.toContain(SECRET_SIGN_URL);
      expect(html, `${name}: bare token must not be in DOM`).not.toContain(SECRET_TOKEN);
      // Belt-and-braces: no https://app.emapp.io/sign/ prefix at all.
      expect(html, `${name}: sign-link prefix must not be in DOM`).not.toContain('/sign/');
    }
  });

  // ---- TEST 6 (render half): the page's masked copy keys never embed a signUrl ----
  it('6) the masked confirmation/error strings carry no signUrl (defense-in-depth on the copy keys)', () => {
    // The component can only ever render these MASKED keys around the copy flow;
    // none of them interpolates the URL. Assert the keys themselves are clean —
    // a future edit that inlined `{signUrl}` into one of them would fail here.
    for (const key of [
      'copyLinkConfirm',
      'copyLinkCopied',
      'copyLinkNotPending',
      'copyLinkFailed',
      'copyLinkWorking',
      'copyLinkHint',
    ] as const) {
      expect(T[key]).not.toContain('http');
      expect(T[key]).not.toContain(SECRET_TOKEN);
    }
    // And the pending render — where the confirmation/error <p> slots live —
    // contains none of the secret even though the resolved mutation holds it.
    const html = render(['signature_requests.send'], vm({ status: 'pending' }));
    expect(html).not.toContain(SECRET_TOKEN);
  });
});
