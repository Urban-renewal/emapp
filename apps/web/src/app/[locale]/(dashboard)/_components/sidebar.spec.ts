/**
 * P4 #11 — ADVERSARIAL test for the agent sidebar capability-gate.
 *
 * The bug this guards: an agent WITHOUT the `view_owners` capability does NOT
 * hold `owners.read` in their effective permission-set (the BE emits
 * effective = role ∧ capability on `GET /me`), yet the sidebar used to render
 * the Owners nav item unconditionally → clicking it 403/404s (a dead link).
 * The fix gates the Owners item on `useHasPermission('owners.read')`, the same
 * effective-permission pattern already used for members / audit / settings.
 *
 * Why render the real component (not a static-source grep): a source check
 * (`/owners.*canReadOwners/`) is a near-tautology — it asserts the builder
 * typed a token, not that the gate WORKS. This spec instead seeds the exact
 * permission-set the gate reads (`useHasPermission`) and renders the REAL
 * `Sidebar` via `react-dom/server` (the repo's vitest env is `node`, no DOM /
 * testing-library — `renderToStaticMarkup` returns an HTML string we assert
 * on). The `...(canReadOwners ? [ownersItem] : [])` spread is therefore
 * genuinely exercised: without the fix, test 1 (the absent case) would render
 * the Owners label and FAIL.
 *
 * The permission Set is mutable across tests via `currentPerms`; each test
 * seeds it and asserts the rendered nav. Labels are matched against the real
 * he.json `nav.*` Hebrew strings so a renamed/removed translation key also
 * surfaces here.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Real he.json nav labels (the rendered text we assert on). Kept in sync
//     with src/messages/he.json `nav` namespace; a drift here is intentional
//     signal, not noise — these are the strings a real user sees. ---
const NAV_LABEL: Record<string, string> = {
  home: 'ראשי',
  inbox: 'החלטות ממתינות',
  projects: 'פרויקטים',
  owners: 'בעלי דירות',
  imports: 'ייבוא',
  documents: 'מסמכים',
  messages: 'הודעות',
  signatureRequests: 'בקשות חתימה',
  notifications: 'התראות',
  tasks: 'משימות',
  contractors: 'קבלנים',
  notes: 'הערות',
  members: 'חברי ארגון',
  audit: 'יומן ביקורת',
  settings: 'הגדרות',
  tagline: 'התחדשות עירונית',
  navLandmark: 'ניווט ראשי',
  sectionTools: 'ניהול וכלים',
  'role.manager': 'מנהל',
  'role.agent': 'אגנט',
  'role.viewer': 'צופה',
  'role.provider_admin': 'מנהל Provider',
};

/** Mutable effective permission-set the gate hook reads. Seed per test. */
let currentPerms = new Set<string>();

// Gate source: useHasPermission reads the effective `/me` set. We replace the
// whole module so the test controls membership directly — exactly the contract
// the real hook exposes (`permissions.has(permission)`).
vi.mock('@/hooks/use-permissions', () => ({
  useHasPermission: (permission: string) => currentPerms.has(permission),
  usePermissions: () => ({ permissions: currentPerms, isResolved: true }),
}));

// next-intl: useTranslations('nav') → keyed lookup into NAV_LABEL so the
// rendered markup contains real Hebrew labels (or a visible MISSING token if a
// key the component asks for isn't in our table → loud failure, not silent).
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => NAV_LABEL[key] ?? `MISSING:${key}`,
  useLocale: () => 'he',
}));

// next/link → plain anchor so renderToStaticMarkup emits the href + label.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

// usePathname → a SECONDARY route (`/he/imports`). E2 IA-S2 moved the
// management/tools items (imports/contractors/notes/messages/tasks/
// notifications/members/audit/settings) into a collapsible group that is
// COLLAPSED by default and auto-expands only when the active page lives
// inside it. Pointing the active path at a secondary route opens the group so
// the gated rows (members/audit/settings) actually render, which is what these
// gate assertions probe. Owners (the P4 #11 subject) is PRIMARY, so its gate is
// exercised regardless of the group's open/closed state.
vi.mock('next/navigation', () => ({
  usePathname: () => '/he/imports',
}));

// The sidebar's ambient unread/pending badges read three TanStack-Query count
// hooks. This spec renders the Sidebar via `renderToStaticMarkup` with NO
// QueryClientProvider (it's a pure nav-gate probe), so the real hooks would throw
// "No QueryClient set". Stub them to mutable counts (default 0 → the badges
// self-hide, leaving the nav markup the gate assertions read unchanged). The
// pure display rule is unit-tested in nav-badge.helpers.spec.ts; the
// badge-wiring block below seeds non-zero counts to prove the hook→badge→row
// wiring + the secondary-group auto-expand.
let inboxCount = 0;
let notificationsCount = 0;
let messagesCount = 0;
vi.mock('@/hooks/use-notifications', () => ({
  useUnreadCount: () => ({ data: notificationsCount }),
}));
vi.mock('@/hooks/use-conversations', () => ({
  useConversationsUnreadCount: () => ({ data: messagesCount }),
}));
vi.mock('@/hooks/use-proposals', () => ({
  useProposalsPendingCount: () => ({ data: { count: inboxCount } }),
}));

// LogoutButton pulls in Server-Action / cookie machinery we don't exercise
// here — stub to an inert marker so the render stays a pure nav-gate probe.
vi.mock('./logout-button', () => ({
  LogoutButton: () => createElement('button', { type: 'button' }, 'logout'),
}));

// NameDisplay is a bdi wrapper; stub to passthrough so the footer renders.
vi.mock('@/components/ui/name-display', () => ({
  NameDisplay: ({ name }: { name: string }) => createElement('span', null, name),
}));

// Import AFTER the mocks are registered (vi.mock is hoisted, but keep the
// import here to make the ordering intent explicit).
import { Sidebar } from './sidebar';

function renderSidebar(
  perms: string[],
  props?: { userName?: string; userRole?: string; tier?: 'org' | 'provider' },
): string {
  currentPerms = new Set(perms);
  return renderToStaticMarkup(
    createElement(Sidebar, {
      userName: props?.userName ?? 'דנה כהן',
      userRole: props?.userRole ?? 'agent',
      tier: props?.tier ?? 'org',
    }),
  );
}

/** True iff the rendered nav contains the Owners item — matched BOTH ways
 *  (the label text AND the /owners href) so a partial render can't fool us. */
function hasOwnersNav(html: string): boolean {
  return html.includes(NAV_LABEL.owners!) || /href="\/owners"/.test(html);
}

// The base items that must ALWAYS render regardless of permissions (sidebar.tsx
// marks each `enabled: true` and ungated). Owners is deliberately EXCLUDED — it
// is the gated one under test.
const ALWAYS_ON_BASE = [
  'home',
  'projects',
  'imports',
  'documents',
  'signatureRequests',
  'notifications',
  'tasks',
  'contractors',
  'notes',
] as const;

beforeEach(() => {
  currentPerms = new Set();
  inboxCount = 0;
  notificationsCount = 0;
  messagesCount = 0;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar — Owners capability-gate (P4 #11)', () => {
  // ---- TEST 1: THE BUG SCENARIO — Owners HIDDEN when owners.read absent ----
  it('1) HIDES Owners when the actor lacks owners.read (agent w/o view_owners)', () => {
    // An agent whose effective set has the usual base reads but NOT owners.read
    // (because view_owners is OFF). Pre-fix this rendered Owners anyway → bug.
    const html = renderSidebar([
      'projects.read',
      'documents.read',
      'tasks.read',
      // NOTE: owners.read intentionally ABSENT.
    ]);
    expect(hasOwnersNav(html)).toBe(false);
    // Belt-and-braces: neither the label nor the href may appear.
    expect(html).not.toContain(NAV_LABEL.owners);
    expect(html).not.toMatch(/href="\/owners"/);
  });

  // ---- TEST 2: Owners SHOWN when owners.read present ----
  it('2) SHOWS Owners when the actor holds owners.read', () => {
    for (const role of ['manager', 'agent', 'viewer'] as const) {
      // Each of these roles, when they hold owners.read in their effective set,
      // must see the Owners link (manager/viewer always do; agent iff view_owners).
      const html = renderSidebar(['owners.read'], { userRole: role });
      expect(hasOwnersNav(html), `role=${role} should see Owners`).toBe(true);
      expect(html, `role=${role}`).toContain(NAV_LABEL.owners);
      expect(html, `role=${role}`).toMatch(/href="\/owners"/);
    }
  });

  // ---- TEST 3: No over-hiding — siblings still render in the absent case ----
  it('3) keeps every always-on base nav item when Owners is gated out', () => {
    const html = renderSidebar([]); // empty set: ONLY base ungated items + no Owners
    // Owners gone…
    expect(hasOwnersNav(html)).toBe(false);
    // …but every ungated sibling still present (the gate removed ONLY Owners).
    for (const key of ALWAYS_ON_BASE) {
      expect(html, `base item "${key}" must still render`).toContain(NAV_LABEL[key]);
    }
    // And specifically the two slot-neighbours of Owners (Projects before,
    // Imports after) survive — proves the conditional spread didn't eat them.
    expect(html).toMatch(/href="\/projects"/);
    expect(html).toMatch(/href="\/imports"/);
  });

  // ---- TEST 4: Consistency — members / audit / settings still gate as before ----
  it('4a) HIDES members/audit/settings when their read perms are absent', () => {
    const html = renderSidebar(['owners.read']); // owners on, the others off
    expect(html).not.toContain(NAV_LABEL.members);
    expect(html).not.toContain(NAV_LABEL.audit);
    // NOTE: settings is asserted via href — its label "הגדרות" could collide
    // with other namespaces if the table grew; href is unambiguous.
    expect(html).not.toMatch(/href="\/members"/);
    expect(html).not.toMatch(/href="\/audit"/);
    expect(html).not.toMatch(/href="\/settings"/);
  });

  it('4b) SHOWS members/audit/settings when their read perms are present', () => {
    const html = renderSidebar(['members.read', 'audit.read', 'org.settings.read']);
    expect(html).toMatch(/href="\/members"/);
    expect(html).toMatch(/href="\/audit"/);
    expect(html).toMatch(/href="\/settings"/);
    // …and Owners stays hidden here (its perm wasn't granted) — proves each
    // gate is independent, no accidental coupling.
    expect(hasOwnersNav(html)).toBe(false);
  });

  // ---- Extra adversarial guard: a NEAR-MISS permission string must NOT open
  //      the gate (membership is exact-string, not prefix/substring). ----
  it('5) does NOT show Owners for near-miss permission strings', () => {
    for (const near of ['owners.reveal_pii', 'owners', 'owners.read.extra', 'owners.write']) {
      const html = renderSidebar([near]);
      expect(hasOwnersNav(html), `near-miss "${near}" must NOT open the gate`).toBe(false);
    }
  });
});

/**
 * M2 — nav ambient unread/pending badges. The badges read the three constant-time
 * count hooks (mocked above to mutable counts). The default `usePathname` mock is
 * `/he/imports`, a SECONDARY route, so the "ניהול וכלים" group is auto-expanded
 * and the Notifications/Messages rows (and their badges) render in this SSR probe.
 * (The unread-driven auto-expand is effect-driven and so browser-only — it is
 * verified in the real-Chrome walk, not in `renderToStaticMarkup`, which skips
 * effects.) The pure cap/hidden rule lives in nav-badge.helpers.spec.ts; here we
 * prove the hook→badge→row WIRING: the right count lands on the right row,
 * self-hides at 0, and shows "99+" above the cap.
 */
describe('Sidebar — M2 ambient nav badges', () => {
  // Extract the pill text (the count digit / "99+") that follows a given nav
  // label in the rendered markup — proves the badge sits ON that row.
  function badgeAfter(html: string, href: string): string | null {
    // The row is an <a href="..."> … and the pill is a <span role="status"> with
    // the count as its text. Find the row, then the first role="status" span
    // within a short window after it.
    const rowIdx = html.indexOf(`href="${href}"`);
    if (rowIdx === -1) return null;
    const after = html.slice(rowIdx);
    const m = after.match(/role="status"[^>]*>([^<]+)</);
    return m ? m[1]!.trim() : null;
  }

  it('1) inbox row shows the manager pending-decisions count', () => {
    inboxCount = 3;
    const html = renderSidebar(['owners.read'], { userRole: 'manager' });
    expect(html).toMatch(/href="\/inbox"/);
    expect(badgeAfter(html, '/inbox')).toBe('3');
  });

  it('2) notifications + messages rows show their unread counts', () => {
    notificationsCount = 5;
    messagesCount = 2;
    const html = renderSidebar(['owners.read'], { userRole: 'manager' });
    expect(badgeAfter(html, '/notifications')).toBe('5');
    expect(badgeAfter(html, '/messages')).toBe('2');
  });

  it('3) NO badge at 0 on any row (calm — no "0" pill)', () => {
    inboxCount = 0;
    notificationsCount = 0;
    messagesCount = 0;
    const html = renderSidebar(['owners.read'], { userRole: 'manager' });
    expect(badgeAfter(html, '/inbox')).toBeNull();
    expect(badgeAfter(html, '/notifications')).toBeNull();
    expect(badgeAfter(html, '/messages')).toBeNull();
    // No status pill anywhere in the nav when everything is zero.
    expect(html).not.toMatch(/role="status"/);
  });

  it('4) applies the "99+" display ceiling above the cap', () => {
    inboxCount = 150;
    const html = renderSidebar(['owners.read'], { userRole: 'manager' });
    expect(badgeAfter(html, '/inbox')).toBe('99+');
  });

  it('5) non-manager: NO inbox row + NO inbox badge (manager-only request never fires)', () => {
    inboxCount = 9; // even if the mock had a value, the row/badge must not render
    const html = renderSidebar(['owners.read'], { userRole: 'agent' });
    expect(html).not.toMatch(/href="\/inbox"/);
    expect(badgeAfter(html, '/inbox')).toBeNull();
  });
});
