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
  'explain.trigger': 'למה אני רואה את זה?',
  'explain.body': 'המיון לפי דחיפות',
  'allClear.title': 'הכול תחת שליטה',
  'allClear.hint': 'אין כרגע פרויקט שדורש את תשומת לבך.',
  'allClear.badge': 'הכול במקום',
  'empty.noProjectsTitle': 'אין עדיין פרויקטים',
  'empty.noProjectsHint': 'כשייווצר הפרויקט הראשון',
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
  Sparkles: () => createElement('span', { 'data-icon': 'sparkles' }),
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

// StatusBadge passthrough so the tag text renders.
vi.mock('@/components/ui/status-badge', () => ({
  StatusBadge: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));

import {
  buildRemindErrorMessage,
  buildRemindResultMessage,
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
