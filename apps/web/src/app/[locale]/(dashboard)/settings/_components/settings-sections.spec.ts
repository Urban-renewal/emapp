/**
 * P6-2 — ADVERSARIAL tests for the three per-org settings SECTIONS
 * (Branding / Localization / Limits). Test-author, separate from the builder.
 *
 * NODE-ENV NOTE on rendered VALUES: `renderToStaticMarkup` is a server render
 * — React `useEffect` does NOT run, so the `useEffect(() => setX(data…))` seed
 * in each section never fires. The inputs therefore render at their INITIAL
 * `useState` value (senderName '', bulkCap '200', pageSize '25', locale 'he',
 * timezone 'Asia/Jerusalem'), NOT the seeded server value. We assert structure
 * (the field/select exists with its bound attributes), not the post-effect
 * value — driving the effect-seeded value needs a DOM render the harness lacks.
 *
 * Harness: the repo's component-test pattern (see
 * `_components/sidebar.spec.ts`) — vitest env is `node` (no DOM, no
 * testing-library), so we render the REAL components through
 * `react-dom/server`'s `renderToStaticMarkup` and assert on the returned HTML
 * string. The data/permission seams are replaced with `vi.mock`:
 *   • `useHasPermission(p)` reads a mutable `currentPerms` Set → we toggle
 *     `org.settings.read` / `org.settings.update` per test.
 *   • `useOrgSettings()` returns a seeded, fully-resolved `OrgSettings`.
 *   • `useUpdateOrgSettings()` returns an inert mutation whose `mutate` is a
 *     spy (the submit handler is not invokable from a static render — see the
 *     NODE-ENV LIMIT note on test 5/6 — so the spy guards "never called as a
 *     side-effect of render", and the namespace/`emailFrom` scoping is pinned
 *     at the SOURCE level which is the load-bearing assertion).
 *
 * What is genuinely exercised (not a tautology): the real `if (!canRead)`
 * early-return branch, the real `disabled={!canWrite || …}` fieldset gate, the
 * real `canWrite ? <Save/> : <readOnly note/>` branch, and the real
 * display-only `emailFrom` JSX — each rendered from the actual component, so a
 * builder regression (e.g. dropping the fieldset-disable, or wiring emailFrom
 * into the editable form) flips a concrete assertion red.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import type { OrgSettings } from '@emapp/shared-types';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Real he.json labels the sections render (the strings a user sees). A drift
//    here is intentional signal — these mirror src/messages/he.json
//    `settings.{branding,localization,limits}`. ───────────────────────────────
const L = {
  branding: {
    section: 'זהות השולח',
    senderName: 'שם השולח',
    emailFrom: 'כתובת שולח מותאמת',
    emailFromNote:
      'כתובת שולח מותאמת תתאפשר רק לאחר אימות דומיין בבעלות הארגון. כרגע התצוגה לקריאה בלבד וההודעות נשלחות מכתובת המערכת המאומתת.',
    readOnly: 'אין לך הרשאה לעדכן את הגדרות הארגון. התצוגה לקריאה בלבד.',
    noPermission: 'אין לך הרשאה לצפות בהגדרות הארגון.',
    save: 'שמירה',
  },
  localization: {
    section: 'שפה ואזור זמן',
    locale: 'שפה',
    timezone: 'אזור זמן',
    optionHe: 'עברית',
    optionEn: 'English',
    optionAr: 'العربية',
    readOnly: 'אין לך הרשאה לעדכן את הגדרות הארגון. התצוגה לקריאה בלבד.',
    noPermission: 'אין לך הרשאה לצפות בהגדרות הארגון.',
    save: 'שמירה',
  },
  limits: {
    section: 'מגבלות תפעוליות',
    bulkCap: 'מקסימום שורות בפעולה מרובה',
    defaultPageSize: 'גודל עמוד ברירת מחדל',
    readOnly: 'אין לך הרשאה לעדכן את הגדרות הארגון. התצוגה לקריאה בלבד.',
    noPermission: 'אין לך הרשאה לצפות בהגדרות הארגון.',
    save: 'שמירה',
  },
} as const;

/** Mutable effective permission-set the gate hook reads. Seed per test. */
let currentPerms = new Set<string>();
/** Spy capturing any PATCH payload the components attempt to send. */
const mutateSpy = vi.fn();

// A seeded, fully-resolved OrgSettings with NON-default, distinguishable values
// so an assertion on a rendered field value can't accidentally pass on a
// default. emailFrom is deliberately POPULATED to prove it renders display-only.
const SEEDED: OrgSettings = {
  notifications: { defaultChannels: ['in_app'] },
  messaging: { templates: {} },
  branding: { senderName: 'מארגון בדיקה', emailFrom: 'noreply@example.org' },
  locale: 'en',
  timezone: 'UTC',
  signatures: { linkTtlDays: 7, channels: ['sms', 'email', 'whatsapp'] },
  consent: { tama38_1: 66, tama38_2: 80, pinui_binui: 80 },
  privacy: { noticeText: 'הודעת פרטיות', noticeVersion: 'v1', requireExplicitConsent: false },
  limits: { bulkCap: 321, defaultPageSize: 77 },
  security: { piiUnlockTtlMinutes: 60 },
};

// ── Mocks (hoisted before the component imports) ─────────────────────────────
vi.mock('@/hooks/use-permissions', () => ({
  useHasPermission: (permission: string) => currentPerms.has(permission),
  usePermissions: () => ({ permissions: currentPerms, isResolved: true }),
}));

// The data hook returns the seeded resolved settings (loaded, no error).
vi.mock('@/hooks/use-org-settings', () => ({
  useOrgSettings: () => ({ data: SEEDED, isLoading: false, isError: false }),
  useUpdateOrgSettings: () => ({
    mutate: mutateSpy,
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
}));

// next-intl: useTranslations('settings.X') → a keyed lookup into the matching
// he.json subtree (incl. the nested `localeOption.<loc>` keys the localization
// select renders). An unknown key surfaces as a loud MISSING token.
vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    const labels: Record<string, (key: string) => string> = {
      'settings.branding': (key) => brandingLabel(key),
      'settings.localization': (key) => localizationLabel(key),
      'settings.limits': (key) => limitsLabel(key),
    };
    return labels[ns] ?? ((key: string) => `MISSING-NS:${ns}.${key}`);
  },
  useLocale: () => 'he',
}));

function brandingLabel(key: string): string {
  const map: Record<string, string> = {
    section: L.branding.section,
    description: 'desc',
    senderName: L.branding.senderName,
    senderNameHint: 'hint',
    senderNameRequired: 'req',
    emailFrom: L.branding.emailFrom,
    emailFromPlaceholder: 'ph',
    emailFromNote: L.branding.emailFromNote,
    save: L.branding.save,
    saving: 'saving',
    saved: 'saved',
    saveError: 'saveError',
    loading: 'loading',
    loadError: 'loadError',
    readOnly: L.branding.readOnly,
    noPermission: L.branding.noPermission,
  };
  return map[key] ?? `MISSING:branding.${key}`;
}
function localizationLabel(key: string): string {
  const map: Record<string, string> = {
    section: L.localization.section,
    description: 'desc',
    locale: L.localization.locale,
    'localeOption.he': L.localization.optionHe,
    'localeOption.en': L.localization.optionEn,
    'localeOption.ar': L.localization.optionAr,
    timezone: L.localization.timezone,
    timezoneHint: 'hint',
    save: L.localization.save,
    saving: 'saving',
    saved: 'saved',
    saveError: 'saveError',
    loading: 'loading',
    loadError: 'loadError',
    readOnly: L.localization.readOnly,
    noPermission: L.localization.noPermission,
  };
  return map[key] ?? `MISSING:localization.${key}`;
}
function limitsLabel(key: string): string {
  const map: Record<string, string> = {
    section: L.limits.section,
    description: 'desc',
    bulkCap: L.limits.bulkCap,
    bulkCapHint: 'hint',
    defaultPageSize: L.limits.defaultPageSize,
    defaultPageSizeHint: 'hint',
    outOfBounds: 'oob',
    save: L.limits.save,
    saving: 'saving',
    saved: 'saved',
    saveError: 'saveError',
    loading: 'loading',
    loadError: 'loadError',
    readOnly: L.limits.readOnly,
    noPermission: L.limits.noPermission,
  };
  return map[key] ?? `MISSING:limits.${key}`;
}

// Import AFTER the mocks (vi.mock is hoisted; explicit ordering for clarity).
import { BrandingConfig } from './branding-config';
import { LimitsConfig } from './limits-config';
import { LocalizationConfig } from './localization-config';

type Section = () => ReactNode;

function render(Section: Section, perms: string[]): string {
  currentPerms = new Set(perms);
  return renderToStaticMarkup(createElement(Section));
}

/** Extract the full opening `<input …>` / `<select …>` tag carrying
 *  `name="<name>"`, so attribute assertions are ORDER-INDEPENDENT (React's
 *  server renderer does not preserve source attribute order). Returns '' if
 *  absent. The `name` argument is a fixed literal at every call site (no
 *  dynamic RegExp from untrusted input). */
function tagByName(html: string, tag: 'input' | 'select', name: string): string {
  const open = tag === 'input' ? /<input\b[^>]*>/g : /<select\b[^>]*>/g;
  const needle = `name="${name}"`;
  for (const m of html.matchAll(open)) {
    if (m[0].includes(needle)) return m[0];
  }
  return '';
}

const READ = ['org.settings.read'];
const READ_WRITE = ['org.settings.read', 'org.settings.update'];

// Read the raw component sources once — used for the SOURCE-level namespace /
// emailFrom-scoping assertions (the parts a static render can't drive). Reading
// the file is NOT a tautology here: it pins the EXACT object literal each
// section's submit handler passes to `mutate`, so a builder change that widens
// branding's PATCH to include emailFrom (the load-bearing footgun) fails.
const DIR = __dirname;
const brandingSrc = readFileSync(join(DIR, 'branding-config.tsx'), 'utf8');
const localizationSrc = readFileSync(join(DIR, 'localization-config.tsx'), 'utf8');
const limitsSrc = readFileSync(join(DIR, 'limits-config.tsx'), 'utf8');

beforeEach(() => {
  currentPerms = new Set();
  mutateSpy.mockClear();
});
afterEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
describe('Settings sections (P6-2) — render + AUTHZ gating', () => {
  // ── TEST 1: renders fields for org.settings.read ──────────────────────────
  it('1) renders each section’s fields when org.settings.read is granted', () => {
    const branding = render(BrandingConfig, READ);
    expect(branding).toContain(L.branding.section);
    expect(branding).toContain(L.branding.senderName);
    // The senderName text input is rendered (value is effect-seeded at runtime,
    // not under static render — see the NODE-ENV NOTE in the file header).
    expect(tagByName(branding, 'input', 'senderName'), 'senderName input').toMatch(/type="text"/);

    const localization = render(LocalizationConfig, READ);
    expect(localization).toContain(L.localization.section);
    expect(localization).toContain(L.localization.locale);
    expect(localization).toContain(L.localization.timezone);
    expect(tagByName(localization, 'select', 'locale'), 'locale select').not.toBe('');
    expect(tagByName(localization, 'select', 'timezone'), 'timezone select').not.toBe('');

    const limits = render(LimitsConfig, READ);
    expect(limits).toContain(L.limits.section);
    expect(limits).toContain(L.limits.bulkCap);
    expect(limits).toContain(L.limits.defaultPageSize);
    expect(tagByName(limits, 'input', 'bulkCap'), 'bulkCap input').toMatch(/type="number"/);
    expect(tagByName(limits, 'input', 'defaultPageSize'), 'defaultPageSize input').toMatch(
      /type="number"/,
    );
  });

  // ── TEST 2: no read permission → blurb only, no controls ─────────────────
  it('2) shows the no-permission blurb and NO editable controls without org.settings.read', () => {
    for (const [name, Section, copy] of [
      ['branding', BrandingConfig, L.branding.noPermission],
      ['localization', LocalizationConfig, L.localization.noPermission],
      ['limits', LimitsConfig, L.limits.noPermission],
    ] as const) {
      const html = render(Section, []); // no read perm
      expect(html, `${name}: no-permission copy`).toContain(copy);
      // No form, no inputs/selects, no Save button.
      expect(html, `${name}: no <form>`).not.toContain('<form');
      expect(html, `${name}: no <input>`).not.toContain('<input');
      expect(html, `${name}: no <select>`).not.toContain('<select');
      expect(html, `${name}: no Save`).not.toContain('>שמירה<');
      expect(html, `${name}: no readOnly note either`).not.toContain(L.branding.readOnly);
    }
  });

  // ── TEST 3: write gated — read-only without org.settings.update ──────────
  it('3a) without org.settings.update: fieldset disabled, NO Save, read-only note shown', () => {
    for (const [name, Section, readOnly] of [
      ['branding', BrandingConfig, L.branding.readOnly],
      ['localization', LocalizationConfig, L.localization.readOnly],
      ['limits', LimitsConfig, L.limits.readOnly],
    ] as const) {
      const html = render(Section, READ); // read but NOT update
      // The editable fieldset is rendered DISABLED.
      expect(html, `${name}: fieldset disabled`).toMatch(/<fieldset[^>]*disabled/);
      // Save button is NOT rendered (canWrite ? Save : readOnly-note).
      expect(html, `${name}: Save hidden`).not.toContain('type="submit"');
      // The read-only note IS shown.
      expect(html, `${name}: read-only note`).toContain(readOnly);
    }
  });

  it('3b) with org.settings.update: Save renders and fieldset is NOT disabled', () => {
    for (const [name, Section] of [
      ['branding', BrandingConfig],
      ['localization', LocalizationConfig],
      ['limits', LimitsConfig],
    ] as const) {
      const html = render(Section, READ_WRITE);
      expect(html, `${name}: Save shown`).toContain('type="submit"');
      expect(html, `${name}: Save label`).toContain(L.branding.save); // 'שמירה'
      // fieldset present but WITHOUT a disabled attribute.
      expect(html, `${name}: fieldset present`).toMatch(/<fieldset/);
      expect(html, `${name}: fieldset enabled`).not.toMatch(/<fieldset[^>]*disabled/);
      // The read-only note is NOT shown when writable.
      expect(html, `${name}: no read-only note`).not.toContain(L.branding.readOnly);
    }
  });

  // ── TEST 4: emailFrom NOT patchable (LOAD-BEARING) ───────────────────────
  it('4) branding emailFrom is display-only (disabled+readOnly) and never in the PATCH payload', () => {
    const html = render(BrandingConfig, READ_WRITE);
    // The emailFrom field renders with its stored value, disabled AND readonly.
    // (emailFrom is read straight from `data` — not effect-seeded local state —
    // so its value IS present under static render, unlike senderName.)
    const emailFromTag = tagByName(html, 'input', 'emailFrom');
    expect(emailFromTag, 'emailFrom input present').not.toBe('');
    expect(emailFromTag, 'emailFrom disabled').toMatch(/\bdisabled\b/);
    expect(emailFromTag, 'emailFrom readOnly').toMatch(/\breadonly\b/i);
    expect(emailFromTag, 'emailFrom shows stored value').toContain('noreply@example.org');
    // The "needs domain verification" note renders.
    expect(html, 'emailFrom verification note').toContain(L.branding.emailFromNote);

    // LOAD-BEARING source assertion: the branding submit handler PATCHes EXACTLY
    // { branding: { senderName } } — emailFrom never appears in any mutate(...)
    // call. (A static render can't drive onSubmit; this pins the payload shape.)
    const mutateCalls = brandingSrc.match(/mutation\.mutate\([^;]*\)/g) ?? [];
    expect(mutateCalls.length, 'branding has a mutate call').toBeGreaterThan(0);
    for (const call of mutateCalls) {
      expect(call, 'branding mutate is { branding: { senderName } }').toContain('branding');
      expect(call, 'branding mutate carries senderName').toContain('senderName');
      expect(call, 'branding mutate must NOT carry emailFrom').not.toContain('emailFrom');
    }
    // Render itself never triggers a write.
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  // ── TEST 5: client bounds attributes present ─────────────────────────────
  // NODE-ENV LIMIT: a static render seeds the inputs at their initial values and
  // cannot drive onChange, so "out-of-bounds disables Save" is not exercisable
  // here (it needs a DOM event). We instead assert the bound ATTRIBUTES are on
  // the rendered inputs (the SSR contract the browser enforces natively) and the
  // exact locale option set.
  it('5) bound attributes are present on the inputs and locale options are exactly he/en/ar', () => {
    const branding = render(BrandingConfig, READ_WRITE);
    expect(tagByName(branding, 'input', 'senderName'), 'senderName maxLength=120').toMatch(
      /maxlength="120"/i,
    );

    const limits = render(LimitsConfig, READ_WRITE);
    const bulkCapTag = tagByName(limits, 'input', 'bulkCap');
    expect(bulkCapTag, 'bulkCap min=1').toMatch(/\bmin="1"/);
    expect(bulkCapTag, 'bulkCap max=1000').toMatch(/\bmax="1000"/);
    const pageSizeTag = tagByName(limits, 'input', 'defaultPageSize');
    expect(pageSizeTag, 'defaultPageSize min=1').toMatch(/\bmin="1"/);
    expect(pageSizeTag, 'defaultPageSize max=100').toMatch(/\bmax="100"/);

    const localization = render(LocalizationConfig, READ_WRITE);
    const optionValues = [...localization.matchAll(/<option[^>]*value="([^"]+)"/g)].map(
      (m) => m[1],
    );
    // locale select is the first select; its options are exactly he/en/ar (the
    // timezone select's option values are zone strings, never 2-letter locales).
    const localeOptions = optionValues.filter((v) => v && v.length === 2);
    expect(localeOptions, 'locale options exactly he/en/ar').toEqual(['he', 'en', 'ar']);
  });

  // ── TEST 6: PATCH sends only its OWN namespace (source-pinned) ───────────
  // NODE-ENV LIMIT: onSubmit isn't invokable from a static render, so the
  // namespace scoping is pinned by reading each submit handler. Each section's
  // mutate(...) references ONLY its own namespace key — never a sibling's.
  it('6) each section PATCHes only its own namespace (no cross-namespace leakage)', () => {
    // Branding → branding only.
    const brandingCall = (brandingSrc.match(/mutation\.mutate\([^;]*\)/g) ?? []).join(' ');
    expect(brandingCall).toContain('branding');
    expect(brandingCall, 'branding mutate touches no sibling').not.toMatch(
      /\b(limits|locale|timezone|signatures|consent|messaging|notifications)\b/,
    );

    // Limits → limits only (bulkCap + defaultPageSize).
    const limitsCall = (limitsSrc.match(/mutation\.mutate\([^;]*\)/g) ?? []).join(' ');
    expect(limitsCall).toContain('limits');
    expect(limitsCall).toContain('bulkCap');
    expect(limitsCall).toContain('defaultPageSize');
    expect(limitsCall, 'limits mutate touches no sibling').not.toMatch(
      /\b(branding|signatures|consent|messaging|notifications)\b/,
    );

    // Localization → only the changed scalar(s): locale / timezone, nothing else.
    // The handler builds a `patch` object then calls mutate(patch); assert the
    // patch is assembled solely from locale/timezone and no object namespace.
    expect(localizationSrc).toMatch(/patch\.locale\s*=/);
    expect(localizationSrc).toMatch(/patch\.timezone\s*=/);
    expect(localizationSrc, 'localization patch has no object-namespace key').not.toMatch(
      /patch\.(branding|limits|signatures|consent|messaging|notifications)\b/,
    );
  });
});
