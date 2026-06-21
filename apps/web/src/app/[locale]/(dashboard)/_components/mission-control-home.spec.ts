/**
 * E2 Wave-2 E2.1 — MissionControlHome render test (the board-first home).
 *
 * Proves the centerpiece renders its calm contract: greeting + the ONE pulse
 * sentence (from buckets) + the ranked ActionCards (server order preserved,
 * each with its plain-Hebrew "why" + the consent % WITH the mandatory basis
 * label) + the explain affordance, AND the calm states via DataState (loading
 * skeleton / error+retry / the all-clear reward empty-state). Plus the Viewer
 * read-only contract: the mutating "remind" link is hidden without the send
 * permission; "open project" (read-navigation) always shows.
 *
 * Harness mirrors data-state.spec.ts: vitest env `node`, render via
 * `renderToStaticMarkup`, stub next-intl/next-link/lucide + the data hooks.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SignaturePulseViewModel } from '@/models/signature-pulse.vm';

// next-intl: a small table of the REAL he.json `home.pulse` + `consent` copy
// the component asks for. A missing key renders MISSING:<key> → loud failure.
const T: Record<string, string> = {
  subtitleLoading: 'בודקים מה דורש את תשומת לבך…',
  attentionHeading: 'דורש את תשומת לבך',
  'greeting.morning': 'בוקר טוב',
  'greeting.afternoon': 'צהריים טובים',
  'greeting.evening': 'ערב טוב',
  'reason.stalled.tag': 'תקוע',
  'reason.expiring.tag': 'פג בקרוב',
  'reason.consentGap.tag': 'חסרות חתימות',
  'reason.notStarted.tag': 'טרם התחיל',
  'action.open': 'פתח פרויקט',
  'action.remind': 'שלח תזכורת',
  'action.remindPending': 'שולח…',
  'action.remindDisabled': 'שליחת תזכורות מושהית כרגע',
  'action.remindNonePending': 'אין חתימות ממתינות בפרויקט',
  'action.remindFailed': 'שליחת התזכורות נכשלה. אפשר לנסות שוב.',
  'action.startCampaign': 'התחל איסוף חתימות',
  'explain.trigger': 'למה אני רואה את זה?',
  'explain.body': 'המיון לפי דחיפות',
  'allClear.title': 'הכול תחת שליטה',
  'allClear.hint': 'אין כרגע פרויקט שדורש את תשומת לבך.',
  'allClear.badge': 'הכול במקום',
  'empty.noProjectsTitle': 'אין עדיין פרויקטים',
  'empty.noProjectsHint': 'כשייווצר הפרויקט הראשון',
  // HB-3 holdout expander copy.
  'holdouts.toggleShow': 'מי תקוע?',
  'holdouts.toggleHide': 'הסתר מי תקוע',
  'holdouts.loading': 'טוען שמות…',
  'holdouts.loadFailed': 'טעינת השמות נכשלה.',
  'holdouts.retry': 'נסה שוב',
  'holdouts.none': 'אין חותמים תקועים',
  'holdouts.noName': 'בעל דירה ללא שם רשום',
  'holdouts.remindSent': 'התזכורת נשלחה',
  'holdouts.remindNonePending': 'אין בקשת חתימה ממתינה לבעל דירה זה — ייתכן שהלוח אינו מעודכן.',
};

// DataState (rendered by the home for loading/error/empty) calls
// useTranslations('dataState') internally — model those keys too so its panels
// render their real copy instead of MISSING:<key>.
const DATA_STATE: Record<string, string> = {
  errorTitle: 'לא הצלחנו לטעון את הנתונים',
  errorBody: 'אירעה תקלה זמנית. אפשר לנסות שוב.',
  retry: 'נסה שוב',
  forbiddenTitle: 'אין לך גישה',
  forbiddenBody: 'אין לך הרשאה לצפות בתוכן הזה.',
};

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, vars?: Record<string, unknown>) => {
    if (ns === 'dataState') return DATA_STATE[key] ?? `MISSING:${key}`;
    if (ns === 'consent' && key === 'basisShare') return 'לפי שיעור הבעלות';
    // projects.threshold — the HB-4 ThresholdSliver's a11y strings.
    if (ns === 'projects.threshold') {
      if (key === 'valueTextNoTarget') return `${String(vars?.['pct'])}% — לא הוגדר יעד`;
      if (key === 'ariaLabel') return 'התקדמות ההסכמות לעבר היעד';
      return `MISSING:${key}`;
    }
    // HB-4 queue-tail (and-N-more) line.
    if (key === 'queueTail') return `ועוד ${String(vars?.['count'])} פרויקטים במעקב`;
    // parametrised lines we assert content of:
    if (key === 'reason.stalled.why') return `אין תנועה כבר ${String(vars?.['days'])} ימים`;
    if (key === 'reason.expiring.why') return 'יש בקשת חתימה שעומדת לפוג';
    if (key === 'reason.consentGap.why') return 'עוד לא הגיע ליעד ההסכמות';
    if (key === 'reason.notStarted.why') return 'עדיין לא התקבלו חתימות';
    if (key === 'consentPct') return `${String(vars?.['pct'])}% הסכמה`;
    if (key === 'action.openAria') return `פתח את הפרויקט ${String(vars?.['name'])}`;
    if (key === 'action.remindAria')
      return `שלח תזכורת לחותמים הממתינים בפרויקט ${String(vars?.['name'])}`;
    if (key === 'action.remindSent') return `נשלחו ${String(vars?.['count'])} תזכורות`;
    // HB-3/HB-5 parametrised holdout lines.
    if (key === 'holdouts.fallback') return `דירה ${String(vars?.['number'])} · ממתינה לחתימות`;
    if (key === 'holdouts.apartment') return `דירה ${String(vars?.['number'])}`;
    if (key === 'holdouts.remindAria') return `שלח תזכורת ל${String(vars?.['name'])}`;
    if (key === 'holdouts.requestSent') return `בקשת חתימה נשלחה ל${String(vars?.['name'])}`;
    if (key === 'holdouts.startCampaignAria')
      return `התחל איסוף חתימות בדירה ${String(vars?.['number'])}`;
    if (key === 'action.startCampaignAria')
      return `התחל איסוף חתימות בפרויקט ${String(vars?.['name'])}`;
    if (key.startsWith('clause.')) return `clause:${key}`;
    return T[key] ?? `MISSING:${key}`;
  },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

vi.mock('lucide-react', () => ({
  ArrowLeft: () => createElement('span', { 'data-icon': 'arrow' }),
  BellRing: () => createElement('span', { 'data-icon': 'bell' }),
  CheckCircle2: () => createElement('span', { 'data-icon': 'check' }),
  HelpCircle: () => createElement('span', { 'data-icon': 'help' }),
  Send: () => createElement('span', { 'data-icon': 'send' }),
  Sparkles: () => createElement('span', { 'data-icon': 'sparkles' }),
  Users: () => createElement('span', { 'data-icon': 'users' }),
}));

// TanStack mutation/queryClient — the remind action's plumbing. `useMutation`
// returns an idle, non-pending stub (the click path / invalidation is unit-
// tested via the exported pure helpers below; here we only need the button to
// RENDER its idle state so the SSR markup assertions hold). `mutate` records
// nothing — `renderToStaticMarkup` never fires onClick.
const invalidateSpy = vi.fn();
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
}));

// Action-toast — the result/error feedback primitive. A no-op show() is enough
// for the render-only SSR assertions.
vi.mock('@/components/ui/action-toast', () => ({
  useToast: () => ({ show: vi.fn(), dismiss: vi.fn() }),
}));

// api-client — the remind POST. Not invoked under renderToStaticMarkup; stubbed
// so the module import resolves in the node env.
vi.mock('@/lib/api-client', () => ({
  apiClient: { postIdempotent: vi.fn() },
  isOk: (r: unknown) => Boolean(r && typeof r === 'object' && 'data' in r),
}));

// The pulse hook + the session + permission hooks — seedable per test.
type PulseState = {
  data?: SignaturePulseViewModel;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  refetch: () => void;
};
let pulseState: PulseState;
let canRemind: boolean;
let profileName: string | undefined;

vi.mock('@/hooks/use-signature-pulse', () => ({
  useSignaturePulse: () => pulseState,
}));
vi.mock('@/hooks/use-permissions', () => ({
  useHasPermission: () => canRemind,
}));
vi.mock('@/hooks/use-session', () => ({
  useSessionProfile: () => ({ data: profileName ? { name: profileName } : undefined }),
}));

// HB-3 — the holdout data hooks. Seedable per test. `useSignatureProgressApartments`
// returns the per-project apartment progress; `useApartmentHoldouts` returns the
// per-apartment holdout NAMES (gated). `isPermissionDenied` mirrors the real
// predicate (403 → no-name fallback). `useResendHoldoutReminder` is a useMutation
// stub whose `mutate` records the ownerId it was called with.
type ApartmentsState = {
  data?: Array<{ apartmentId: string; number: string; status: 'consented' | 'partial' | 'none' }>;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};
type HoldoutsState = {
  data?: Array<{ ownerId: string; name: string | null; apartmentNumber: string }>;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  refetch: () => void;
};
let apartmentsState: ApartmentsState;
let holdoutsState: HoldoutsState;
const chaseMutate = vi.fn();

vi.mock('@/hooks/use-projects', () => ({
  useSignatureProgressApartments: () => apartmentsState,
  useApartmentHoldouts: () => holdoutsState,
  isPermissionDenied: (err: unknown) =>
    Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'forbidden'),
}));
vi.mock('@/hooks/use-signature-requests', () => ({
  HOLDOUT_NONE_PENDING_CODE: 'holdout_none_pending',
  useChaseHoldout: () => ({ mutate: chaseMutate, isPending: false }),
}));

// StatusBadge passthrough so the tag text renders.
vi.mock('@/components/ui/status-badge', () => ({
  StatusBadge: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));

import {
  buildHoldoutRemindErrorMessage,
  buildRemindErrorMessage,
  buildRemindResultMessage,
  HoldoutApartment,
  HoldoutRow,
  MissionControlHome,
} from './mission-control-home';

// A next-intl `t` double matching the component's call shape, backed by the
// same T/parametrised table the next-intl mock uses — so the pure-helper tests
// assert the REAL Hebrew copy the component would render.
const tDouble = ((key: string, vars?: Record<string, unknown>) => {
  if (key === 'action.remindSent') return `נשלחו ${String(vars?.['count'])} תזכורות`;
  return T[key] ?? `MISSING:${key}`;
}) as unknown as Parameters<typeof buildRemindResultMessage>[0];

function card(over: Partial<SignaturePulseViewModel['cards'][number]> = {}) {
  return {
    projectId: 'p1',
    projectName: 'Tama 38/2 — Pilot',
    reason: 'stalled' as const,
    intent: 'danger' as const,
    stalledDays: 26,
    consentedPct: 64,
    basis: 'share' as const,
    metThreshold: false,
    // HB-5 — default to a campaign-active project (the resend/create path).
    campaignDocumentId: 'doc-1',
    hasCampaign: true,
    ...over,
  };
}

function vm(over: Partial<SignaturePulseViewModel> = {}): SignaturePulseViewModel {
  return {
    buckets: { stalled: 1, expiringSoon: 0, needsHuman: 0, onTrack: 2 },
    cards: [card()],
    isAllClear: false,
    totalInScope: 3,
    sendEnabled: true,
    ...over,
  };
}

function render(): string {
  return renderToStaticMarkup(createElement(MissionControlHome));
}

beforeEach(() => {
  pulseState = { data: vm(), isLoading: false, isError: false, refetch: vi.fn() };
  canRemind = true;
  profileName = 'מיכל מנהלת';
  // HB-3 defaults: the expander is collapsed at first render, so these hooks
  // are only consumed once a test opens it (the component gates the queries on
  // `open`). Default to a calm resolved-empty so the render-only tests that
  // DON'T open the expander never hit a holdout panel.
  apartmentsState = { data: [], isLoading: false, isError: false, refetch: vi.fn() };
  holdoutsState = { data: [], isLoading: false, isError: false, refetch: vi.fn() };
  chaseMutate.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('MissionControlHome (E2.1)', () => {
  it('1) renders a greeting with the manager name (wrapped for RTL safety)', () => {
    const html = render();
    // One of the three time-of-day greetings is present.
    expect(/בוקר טוב|צהריים טובים|ערב טוב/.test(html)).toBe(true);
    expect(html).toContain('מיכל מנהלת'); // the name
    expect(html).toContain('<bdi>'); // NameDisplay isolation
  });

  it('2) renders a ranked ActionCard with its WHY + consent % + the basis label', () => {
    const html = render();
    expect(html).toContain('Tama 38/2 — Pilot'); // project name
    expect(html).toContain('אין תנועה כבר 26 ימים'); // the stalled "why"
    expect(html).toContain('64% הסכמה'); // consent %
    // The mandatory basis label — the % is NEVER a bare legal percent.
    expect(html).toContain('לפי שיעור הבעלות');
    expect(html).toContain('תקוע'); // status tag
  });

  it('3) the consent % and basis label always co-occur (no bare %)', () => {
    const html = render();
    const pctIdx = html.indexOf('64% הסכמה');
    const basisIdx = html.indexOf('לפי שיעור הבעלות');
    expect(pctIdx).toBeGreaterThanOrEqual(0);
    expect(basisIdx).toBeGreaterThan(pctIdx); // basis follows the % in the same card
  });

  it('4) "open project" links to the project (read-navigation, always present)', () => {
    const html = render();
    expect(html).toMatch(/href="\/projects\/p1"/);
    expect(html).toContain('פתח פרויקט');
  });

  it('5) Viewer read-only: WITHOUT send permission, the mutating "remind" is hidden', () => {
    canRemind = false;
    const html = render();
    expect(html).not.toContain('שלח תזכורת'); // remind hidden
    expect(html).toContain('פתח פרויקט'); // but open still shows (read-only safe)
  });

  it('5b) WITH send permission, the "remind" action renders as a button (not a link)', () => {
    canRemind = true;
    const html = render();
    expect(html).toContain('שלח תזכורת');
    // The remind action is now an inline <button> (the BE mutation), NOT a
    // <Link> to the signatures tab — assert the button + its project-scoped aria.
    expect(html).toMatch(/<button[^>]*aria-label="שלח תזכורת לחותמים הממתינים בפרויקט/);
    // It must NOT navigate away (no anchor to ?tab=signatures any more).
    expect(html).not.toContain('?tab=signatures');
  });

  it('5c) kill-switch OFF (sendEnabled=false) → the remind button is DISABLED + calm copy', () => {
    canRemind = true;
    pulseState = {
      data: vm({ sendEnabled: false }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    const html = render();
    // The button renders but is disabled (belt-and-suspenders with the BE 503).
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"/);
    // Calm explanatory copy via the native title tooltip — never a silent disable.
    expect(html).toContain('שליחת תזכורות מושהית כרגע');
  });

  it('5d) kill-switch ON (sendEnabled=true) → the remind button is ENABLED', () => {
    canRemind = true;
    const html = render(); // default vm() has sendEnabled: true
    // The enabled button carries no `disabled` attribute and no paused tooltip.
    expect(html).not.toMatch(/<button[^>]*aria-label="שלח תזכורת[^"]*"[^>]*disabled/);
    expect(html).not.toContain('שליחת תזכורות מושהית כרגע');
  });

  it('5e) HB-5: a card with NO campaign → "התחל איסוף חתימות" CTA (a Link), NOT a remind button', () => {
    canRemind = true;
    pulseState = {
      data: vm({
        cards: [
          card({
            reason: 'notStarted',
            intent: 'neutral',
            hasCampaign: false,
            campaignDocumentId: null,
          }),
        ],
        totalInScope: 1,
      }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    const html = render();
    // The primary mutating affordance is a start-campaign Link to the project.
    expect(html).toContain('התחל איסוף חתימות');
    expect(html).toMatch(/href="\/projects\/p1"/);
    // The project-wide remind button is REPLACED (no dead-end remind).
    expect(html).not.toContain('שלח תזכורת');
  });

  it('6) loading → DataState list skeleton (never a bare null)', () => {
    pulseState = { isLoading: true, isError: false, refetch: vi.fn() };
    const html = render();
    expect(html).toContain('skeleton');
    expect(html).not.toContain('Tama 38/2 — Pilot');
  });

  it('7) error → calm DataState error treatment (routes through DataState)', () => {
    pulseState = {
      isLoading: false,
      isError: true,
      error: new Error('boom'),
      refetch: vi.fn(),
    };
    const html = render();
    // DataState error copy (real he.json dataState.errorTitle) — proves the
    // home routes its error through DataState rather than blanking.
    expect(html).toContain('לא הצלחנו לטעון את הנתונים');
    expect(html).not.toContain('Tama 38/2 — Pilot');
  });

  it('8) all-clear → the calm reward empty-state (not a blank, not an alarm)', () => {
    pulseState = {
      data: vm({ cards: [], isAllClear: true, totalInScope: 3 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    const html = render();
    expect(html).toContain('הכול תחת שליטה'); // all-clear title
    expect(html).not.toContain('Tama 38/2 — Pilot'); // no cards
  });

  it('9) no projects at all → the distinct "no projects yet" empty copy', () => {
    pulseState = {
      data: vm({ cards: [], isAllClear: true, totalInScope: 0 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    const html = render();
    expect(html).toContain('אין עדיין פרויקטים');
  });

  it('10) the explain affordance ("why am I seeing this?") is present', () => {
    const html = render();
    expect(html).toContain('למה אני רואה את זה?');
    expect(html).toMatch(/aria-expanded="false"/); // collapsed by default
  });
});

describe('HB-4 per-card consent sliver + queue-tail line', () => {
  it('28) each ActionCard renders a compact consent sliver (progressbar) at its %', () => {
    // Default card() is consentedPct: 64, metThreshold: false.
    const html = render();
    // A thin progressbar with aria-valuenow === the card's consent % — the
    // at-a-glance sliver, distinct from the text "% הסכמה" line.
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="64"/);
    // A meaningful aria-valuetext (never a bare number).
    expect(html).toContain('64% — לא הוגדר יעד');
  });

  it('29) the sliver reflects a MET threshold card with the calm success tone', () => {
    pulseState = {
      data: vm({ cards: [card({ consentedPct: 80, metThreshold: true })], totalInScope: 1 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    const html = render();
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="80"/);
    // Met → the success fill token (calm, not a celebration).
    expect(html).toContain('var(--success-600)');
  });

  it('30) queue-tail: N > 0 (total 3 − 1 shown) → the calm "ועוד N" line', () => {
    const html = render(); // default vm(): totalInScope 3, 1 card → N=2
    expect(html).toContain('ועוד 2 פרויקטים במעקב');
  });

  it('31) queue-tail: N === 0 (every tracked project is on the board) → nothing', () => {
    pulseState = {
      data: vm({ cards: [card()], totalInScope: 1 }), // 1 tracked, 1 shown → N=0
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    const html = render();
    expect(html).not.toContain('פרויקטים במעקב'); // no "and 0 more"
  });

  it('32) queue-tail: suppressed in the all-clear empty-state (no cards shown)', () => {
    pulseState = {
      data: vm({ cards: [], isAllClear: true, totalInScope: 3 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    const html = render();
    // DataState owns the empty-state; the tail never rides alongside it.
    expect(html).not.toContain('פרויקטים במעקב');
  });
});

describe('HB-1 remind result/error toast copy (pure helpers)', () => {
  it('11) total === 0 → "no pending signatures" copy (NOT a "0 sent" line)', () => {
    expect(buildRemindResultMessage(tDouble, { reminded: 0, total: 0 })).toBe(
      'אין חתימות ממתינות בפרויקט',
    );
  });

  it('12) total > 0 → the "{reminded} reminders sent" copy', () => {
    expect(buildRemindResultMessage(tDouble, { reminded: 3, total: 5 })).toBe('נשלחו 3 תזכורות');
  });

  it('13) total > 0 but reminded === 0 → still the "sent" line (count 0), never the empty copy', () => {
    // total>0 means there WERE pending signers; reminded counts deliveries.
    expect(buildRemindResultMessage(tDouble, { reminded: 0, total: 2 })).toBe('נשלחו 0 תזכורות');
  });

  it('14) kill-switch 503 (campaign_send_disabled) → the calm "paused" copy', () => {
    expect(buildRemindErrorMessage(tDouble, { code: 'campaign_send_disabled' })).toBe(
      'שליחת תזכורות מושהית כרגע',
    );
  });

  it('15) any other error → the generic retry copy', () => {
    expect(buildRemindErrorMessage(tDouble, new Error('boom'))).toBe(
      'שליחת התזכורות נכשלה. אפשר לנסות שוב.',
    );
    expect(buildRemindErrorMessage(tDouble, { code: 'not_found' })).toBe(
      'שליחת התזכורות נכשלה. אפשר לנסות שוב.',
    );
  });
});

// ── HB-3 — the inline "מי תקוע?" holdout-name expander ──────────────────────

// A next-intl `t` double for the presentational holdout pieces, backed by the
// same parametrised table the next-intl mock uses (so the components render the
// REAL Hebrew copy under direct SSR).
const tHoldout = ((key: string, vars?: Record<string, unknown>) => {
  if (key === 'holdouts.fallback') return `דירה ${String(vars?.['number'])} · ממתינה לחתימות`;
  if (key === 'holdouts.apartment') return `דירה ${String(vars?.['number'])}`;
  if (key === 'holdouts.remindAria') return `שלח תזכורת ל${String(vars?.['name'])}`;
  if (key === 'holdouts.requestSent') return `בקשת חתימה נשלחה ל${String(vars?.['name'])}`;
  if (key === 'holdouts.startCampaignAria')
    return `התחל איסוף חתימות בדירה ${String(vars?.['number'])}`;
  return T[key] ?? `MISSING:${key}`;
}) as unknown as Parameters<typeof HoldoutRow>[0]['t'];

function holdout(
  over: Partial<{
    ownerId: string;
    name: string | null;
    apartmentNumber: string;
    signableDocumentId: string | null;
  }> = {},
) {
  // HB-5 — default to a per-apartment signable doc (the chase create target).
  return {
    ownerId: 'o1',
    name: 'דנה כהן',
    apartmentNumber: '4',
    signableDocumentId: 'doc-apt-4',
    ...over,
  };
}

describe('HB-3 board-card holdout expander (MissionControlHome)', () => {
  it('16) each card carries a collapsed "מי תקוע?" expander (button, aria-expanded=false)', () => {
    const html = render();
    expect(html).toContain('מי תקוע?');
    // The expander button is collapsed by default — no holdout panel content yet
    // (the names load only ON expand → no PII in the first paint).
    expect(html).toMatch(/aria-expanded="false"[^>]*aria-controls="holdouts-p1"/);
    expect(html).not.toContain('דנה כהן');
  });

  it('17) the expander is keyboard-operable (a real <button>, not a div)', () => {
    const html = render();
    // The toggle that controls holdouts-p1 is a <button type="button">.
    expect(html).toMatch(/<button[^>]*aria-controls="holdouts-p1"/);
  });
});

describe('HB-3 HoldoutApartment — holdout NAMES + masking/403 (presentational)', () => {
  function renderApartment(props?: Partial<Parameters<typeof HoldoutApartment>[0]>): string {
    return renderToStaticMarkup(
      createElement(HoldoutApartment, {
        projectId: 'p1',
        apartmentId: 'a1',
        apartmentNumber: '4',
        canRemind: true,
        sendEnabled: true,
        t: tHoldout,
        ...props,
      }),
    );
  }

  it('18) renders each holdout name via NameDisplay (<bdi> isolation)', () => {
    holdoutsState = {
      data: [holdout(), holdout({ ownerId: 'o2', name: 'משה לוי', apartmentNumber: '4' })],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    const html = renderApartment();
    expect(html).toContain('דנה כהן');
    expect(html).toContain('משה לוי');
    expect(html).toContain('<bdi>'); // NameDisplay bidi-spoof isolation
    // apartment context line present
    expect(html).toContain('דירה 4');
  });

  it('19) MASKED path: a 403 (no view_owner_pii) → the NO-NAME fallback, never a raw name', () => {
    holdoutsState = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { code: 'forbidden' },
      refetch: vi.fn(),
    };
    const html = renderApartment();
    // The fallback line: number + "awaiting signatures", NO owner name revealed.
    expect(html).toContain('דירה 4 · ממתינה לחתימות');
    expect(html).not.toContain('דנה כהן');
    // No remind button either (there is no resolvable name/request to chase).
    expect(html).not.toContain('שלח תזכורת');
  });

  it('20) a name-less shell owner renders the anonymous label, never an empty <bdi>', () => {
    holdoutsState = {
      data: [holdout({ name: null })],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    const html = renderApartment();
    expect(html).toContain('בעל דירה ללא שם רשום');
  });
});

describe('HB-3 HoldoutRow — per-name remind gating + dispatch (presentational)', () => {
  function renderRow(props?: Partial<Parameters<typeof HoldoutRow>[0]>): string {
    return renderToStaticMarkup(
      createElement(HoldoutRow, {
        holdout: holdout(),
        projectId: 'p1',
        canRemind: true,
        sendEnabled: true,
        t: tHoldout,
        ...props,
      }),
    );
  }

  it('21) WITH send permission → a per-name "שלח תזכורת" button with the owner-scoped aria', () => {
    const html = renderRow();
    expect(html).toContain('שלח תזכורת');
    expect(html).toMatch(/<button[^>]*aria-label="שלח תזכורת לדנה כהן"/);
  });

  it('22) GATE: WITHOUT send permission (Viewer) → the per-name remind is HIDDEN', () => {
    const html = renderRow({ canRemind: false });
    expect(html).not.toContain('שלח תזכורת');
    // The name still shows (read), only the mutating action is gated away.
    expect(html).toContain('דנה כהן');
  });

  it('23) kill-switch OFF (sendEnabled=false) → the remind button is DISABLED + calm copy', () => {
    const html = renderRow({ sendEnabled: false });
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"/);
    expect(html).toContain('שליחת תזכורות מושהית כרגע'); // title tooltip
  });
});

// Recursively find the first element whose props carry an onClick handler.
// `HoldoutRow`'s hooks (useToast / useChaseHoldout) are module-mocked to
// return plain objects, so the component can be invoked as a plain function to
// obtain its element tree (the repo's node-env pattern — no real React runtime).
type ReactNodeLike = { props?: { onClick?: () => void; children?: unknown } } | null | undefined;
function findOnClick(node: unknown): (() => void) | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const el = node as ReactNodeLike;
  if (el?.props?.onClick) return el.props.onClick;
  const children = el?.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findOnClick(child);
      if (found) return found;
    }
  } else if (children) {
    return findOnClick(children);
  }
  return undefined;
}

describe('HB-5 per-name chase dispatch (direct onClick)', () => {
  it('24) clicking the action calls the chase mutation with {ownerId, signableDocumentId}', () => {
    // Invoke the component as a plain function (mocked hooks return plain
    // objects) to get its element tree, then call the button's onClick.
    const tree = HoldoutRow({
      holdout: holdout({ ownerId: 'owner-42', signableDocumentId: 'doc-apt-9' }),
      projectId: 'p1',
      canRemind: true,
      sendEnabled: true,
      t: tHoldout,
    });
    const onClick = findOnClick(tree);
    expect(onClick).toBeTypeOf('function');
    onClick?.();
    expect(chaseMutate).toHaveBeenCalledTimes(1);
    // First positional arg is the chase input: this owner + THIS holdout's OWN
    // per-apartment signable doc (HB-5 fix — not the project-wide campaign doc).
    expect(chaseMutate.mock.calls[0]?.[0]).toEqual({
      ownerId: 'owner-42',
      signableDocumentId: 'doc-apt-9',
    });
  });

  it('24b) NO signable doc (signableDocumentId=null) → the per-name action is a START-campaign Link, NOT the chase button', () => {
    const html = renderToStaticMarkup(
      createElement(HoldoutRow, {
        holdout: holdout({ ownerId: 'owner-42', signableDocumentId: null }),
        projectId: 'p7',
        canRemind: true,
        sendEnabled: true,
        t: tHoldout,
      }),
    );
    // A Link to the project (start collection), never a dead-end remind button
    // (and never a create that would 409).
    expect(html).toMatch(/<a[^>]*href="\/projects\/p7"/);
    expect(html).toContain('התחל איסוף חתימות');
    expect(html).not.toContain('שלח תזכורת');
  });
});

describe('HB-3 holdout remind error copy (pure helper)', () => {
  it('25) the "no live pending request" resolve-miss → the honest stale-board copy', () => {
    expect(buildHoldoutRemindErrorMessage(tHoldout, { code: 'holdout_none_pending' })).toBe(
      'אין בקשת חתימה ממתינה לבעל דירה זה — ייתכן שהלוח אינו מעודכן.',
    );
  });

  it('26) kill-switch 503 → the calm "paused" copy', () => {
    expect(buildHoldoutRemindErrorMessage(tHoldout, { code: 'campaign_send_disabled' })).toBe(
      'שליחת תזכורות מושהית כרגע',
    );
  });

  it('27) any other error → the generic retry copy', () => {
    expect(buildHoldoutRemindErrorMessage(tHoldout, new Error('boom'))).toBe(
      'שליחת התזכורות נכשלה. אפשר לנסות שוב.',
    );
  });
});
