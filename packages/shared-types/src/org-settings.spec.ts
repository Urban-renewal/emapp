/**
 * Adversarial unit tests for the pure `resolveOrgSettings` merge function
 * (P1-1 OrgSettings config foundation).
 *
 * Goal: BREAK the fail-soft guarantee. The contract claims:
 *   - empty/missing/null stored value → the FULL default tree;
 *   - a partial override deep-merges (siblings keep their defaults);
 *   - a malformed stored value NEVER throws and degrades to defaults;
 *   - DEFAULT_ORG_SETTINGS is never mutated by a resolve call.
 *
 * Written by the TEST-AUTHOR agent — independent of the builder's own tests.
 * Concrete leaf assertions only; no tautologies.
 */
import { describe, expect, it } from 'vitest';

import {
  resolveOrgSettings,
  DEFAULT_ORG_SETTINGS,
  DEFAULT_PRIVACY_NOTICE_TEXT,
  type OrgSettings,
} from './org-settings';

// A frozen snapshot of the expected default tree, asserted leaf-by-leaf so a
// drift in any single default is caught here (not just "deep-equal to itself").
const FULL_DEFAULT: OrgSettings = {
  notifications: { defaultChannels: ['in_app'] },
  messaging: { templates: {} },
  branding: { senderName: 'EMAPP' },
  locale: 'he',
  timezone: 'Asia/Jerusalem',
  signatures: { linkTtlDays: 7, channels: ['sms', 'email', 'whatsapp'] },
  consent: { tama38_1: 66, tama38_2: 66, pinui_binui: 66 },
  privacy: {
    noticeText: DEFAULT_PRIVACY_NOTICE_TEXT,
    noticeVersion: 'v1',
    requireExplicitConsent: false,
  },
  limits: { bulkCap: 200, defaultPageSize: 25 },
};

/** Assert a resolved tree equals the full default, leaf-by-leaf. */
function expectIsFullDefault(s: OrgSettings): void {
  expect(s.locale).toBe('he');
  expect(s.timezone).toBe('Asia/Jerusalem');
  expect(s.branding.senderName).toBe('EMAPP');
  expect(s.branding.emailFrom).toBeUndefined();
  expect(s.signatures.linkTtlDays).toBe(7);
  expect(s.signatures.channels).toEqual(['sms', 'email', 'whatsapp']);
  expect(s.notifications.defaultChannels).toEqual(['in_app']);
  expect(s.messaging.templates).toEqual({});
  expect(s.consent.tama38_1).toBe(66);
  expect(s.consent.tama38_2).toBe(66);
  expect(s.consent.pinui_binui).toBe(66);
  expect(s.privacy.noticeText).toBe(DEFAULT_PRIVACY_NOTICE_TEXT);
  expect(s.privacy.noticeVersion).toBe('v1');
  expect(s.privacy.requireExplicitConsent).toBe(false);
  expect(s.limits.bulkCap).toBe(200);
  expect(s.limits.defaultPageSize).toBe(25);
}

describe('DEFAULT_ORG_SETTINGS — baseline pin', () => {
  it('exports today-behavior defaults exactly (drift guard)', () => {
    expect(DEFAULT_ORG_SETTINGS).toEqual(FULL_DEFAULT);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 1. Empty / missing / null → full default tree
// ───────────────────────────────────────────────────────────────────────────
describe('resolveOrgSettings — empty / missing / null', () => {
  it('undefined → full default tree', () => {
    expectIsFullDefault(resolveOrgSettings(undefined));
  });

  it('null → full default tree', () => {
    expectIsFullDefault(resolveOrgSettings(null));
  });

  it('{} (the jsonb column default) → full default tree', () => {
    expectIsFullDefault(resolveOrgSettings({}));
  });

  it('no-args coercion path: explicit empty object string-keyed', () => {
    expectIsFullDefault(resolveOrgSettings(Object.create(null) as unknown));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Partial override + deep-merge (siblings survive)
// ───────────────────────────────────────────────────────────────────────────
describe('resolveOrgSettings — partial override deep-merge', () => {
  it('top-level partial { locale: "en" } → locale overridden, every sibling default', () => {
    const s = resolveOrgSettings({ locale: 'en' });
    expect(s.locale).toBe('en');
    // everything else must still be default
    expect(s.timezone).toBe('Asia/Jerusalem');
    expect(s.branding.senderName).toBe('EMAPP');
    expect(s.signatures.linkTtlDays).toBe(7);
    expect(s.signatures.channels).toEqual(['sms', 'email', 'whatsapp']);
    expect(s.notifications.defaultChannels).toEqual(['in_app']);
    expect(s.consent.tama38_1).toBe(66);
    expect(s.limits.bulkCap).toBe(200);
    expect(s.limits.defaultPageSize).toBe(25);
  });

  it('nested partial { signatures: { linkTtlDays: 14 } } → ttl overridden, channels still default', () => {
    const s = resolveOrgSettings({ signatures: { linkTtlDays: 14 } });
    expect(s.signatures.linkTtlDays).toBe(14);
    expect(s.signatures.channels).toEqual(['sms', 'email', 'whatsapp']);
    // sibling namespaces untouched
    expect(s.locale).toBe('he');
    expect(s.limits.bulkCap).toBe(200);
  });

  it('nested partial { consent: { tama38_1: 75 } } → one leaf overridden, sibling consent leaves default', () => {
    const s = resolveOrgSettings({ consent: { tama38_1: 75 } });
    expect(s.consent.tama38_1).toBe(75);
    expect(s.consent.tama38_2).toBe(66);
    expect(s.consent.pinui_binui).toBe(66);
  });

  it('two independent namespaces partially set → both honored, untouched ones default', () => {
    const s = resolveOrgSettings({
      branding: { senderName: 'Renew Co' },
      limits: { defaultPageSize: 50 },
    });
    expect(s.branding.senderName).toBe('Renew Co');
    expect(s.limits.defaultPageSize).toBe(50);
    expect(s.limits.bulkCap).toBe(200); // sibling leaf in a partially-set namespace
    expect(s.signatures.linkTtlDays).toBe(7);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Malformed → fallback, NEVER throws
// ───────────────────────────────────────────────────────────────────────────
describe('resolveOrgSettings — malformed inputs never throw, degrade to defaults', () => {
  const garbage: Array<[string, unknown]> = [
    ['number scalar', 42],
    ['string scalar', 'x'],
    ['boolean scalar', true],
    ['top-level array', [1, 2, 3]],
    ['NaN', Number.NaN],
    ['Symbol-bearing object', { locale: Symbol('he') as unknown }],
  ];

  for (const [label, input] of garbage) {
    it(`${label} → does not throw`, () => {
      expect(() => resolveOrgSettings(input)).not.toThrow();
    });
    it(`${label} → degrades to a valid full default tree`, () => {
      expectIsFullDefault(resolveOrgSettings(input));
    });
  }

  it('wrong-typed leaf locale: 123 → locale reverts to "he", sibling namespaces still default', () => {
    expect(() => resolveOrgSettings({ locale: 123 })).not.toThrow();
    const s = resolveOrgSettings({ locale: 123 });
    // locale is its own namespace → reverts to its default…
    expect(s.locale).toBe('he');
    // …and since nothing else was set, the rest is the full default tree.
    expectIsFullDefault(s);
  });

  it('out-of-enum locale "fr" → degrades to default locale "he"', () => {
    const s = resolveOrgSettings({ locale: 'fr' });
    expect(s.locale).toBe('he');
  });

  it('wrong-typed leaf signatures.linkTtlDays: "abc" → no throw, valid result', () => {
    expect(() => resolveOrgSettings({ signatures: { linkTtlDays: 'abc' } })).not.toThrow();
    const s = resolveOrgSettings({ signatures: { linkTtlDays: 'abc' } });
    // result must be a valid OrgSettings with a numeric ttl
    expect(typeof s.signatures.linkTtlDays).toBe('number');
    expect(s.signatures.linkTtlDays).toBe(7);
  });

  it('channels as scalar "sms" (should be array) → no throw, channels fall back to default array', () => {
    expect(() => resolveOrgSettings({ signatures: { channels: 'sms' } })).not.toThrow();
    const s = resolveOrgSettings({ signatures: { channels: 'sms' } });
    expect(Array.isArray(s.signatures.channels)).toBe(true);
    expect(s.signatures.channels).toEqual(['sms', 'email', 'whatsapp']);
  });

  it('out-of-range numeric leaf bulkCap: 99999 (>max 1000) → no throw, degrades to default', () => {
    expect(() => resolveOrgSettings({ limits: { bulkCap: 99999 } })).not.toThrow();
    const s = resolveOrgSettings({ limits: { bulkCap: 99999 } });
    expect(typeof s.limits.bulkCap).toBe('number');
    expect(s.limits.bulkCap).toBeGreaterThanOrEqual(1);
    expect(s.limits.bulkCap).toBeLessThanOrEqual(1000);
  });

  it('unknown extra top-level keys are tolerated (stripped), known siblings preserved', () => {
    const s = resolveOrgSettings({ locale: 'ar', bogusKey: { deep: 'junk' } });
    expect(s.locale).toBe('ar');
    expect((s as Record<string, unknown>).bogusKey).toBeUndefined();
    expect(s.timezone).toBe('Asia/Jerusalem');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3b. PER-NAMESPACE fail-soft isolation (the new contract).
//
// The fallback granularity is per top-level NAMESPACE, not whole-tree: a
// malformed PRESENT namespace reverts to ITS OWN default, while VALID sibling
// namespaces in the same object SURVIVE. (Previously this degraded the whole
// tree; that behavior is now WRONG and these tests pin the new guarantee.)
// ───────────────────────────────────────────────────────────────────────────
describe('resolveOrgSettings — per-namespace fail-soft (siblings survive a malformed namespace)', () => {
  it('malformed signatures.linkTtlDays:"abc" reverts ONLY signatures; sibling locale:"en" is PRESERVED', () => {
    const s = resolveOrgSettings({ locale: 'en', signatures: { linkTtlDays: 'abc' } });
    // The valid sibling namespace survives — NOT nuked to "he".
    expect(s.locale).toBe('en');
    // The malformed namespace reverts to ITS default (both leaves):
    expect(s.signatures.linkTtlDays).toBe(7);
    expect(s.signatures.channels).toEqual(['sms', 'email', 'whatsapp']);
    // Untouched namespaces remain default.
    expect(s.timezone).toBe('Asia/Jerusalem');
    expect(s.limits.bulkCap).toBe(200);
  });

  it('malformed branding (senderName:"" violates min(1)) reverts ONLY branding; valid consent + limits survive', () => {
    const s = resolveOrgSettings({
      branding: { senderName: '' }, // invalid: min length 1
      consent: { tama38_1: 75 }, // valid override
      limits: { defaultPageSize: 40 }, // valid override
    });
    // branding reverted to its own default:
    expect(s.branding.senderName).toBe('EMAPP');
    expect(s.branding.emailFrom).toBeUndefined();
    // valid sibling overrides in OTHER namespaces survive:
    expect(s.consent.tama38_1).toBe(75);
    expect(s.consent.tama38_2).toBe(66); // unset leaf in that namespace = default
    expect(s.limits.defaultPageSize).toBe(40);
    expect(s.limits.bulkCap).toBe(200);
    // wholly-untouched namespaces are default:
    expect(s.locale).toBe('he');
  });

  it('malformed consent (tama38_2:150 > max 100) reverts ONLY consent; valid signatures + branding survive', () => {
    const s = resolveOrgSettings({
      consent: { tama38_2: 150 }, // out of range → whole consent namespace reverts
      signatures: { linkTtlDays: 21 }, // valid
      branding: { senderName: 'Renew Co' }, // valid
    });
    // consent reverted ENTIRELY to default (per-namespace, not per-leaf):
    expect(s.consent.tama38_1).toBe(66);
    expect(s.consent.tama38_2).toBe(66);
    expect(s.consent.pinui_binui).toBe(66);
    // valid siblings survive:
    expect(s.signatures.linkTtlDays).toBe(21);
    expect(s.signatures.channels).toEqual(['sms', 'email', 'whatsapp']);
    expect(s.branding.senderName).toBe('Renew Co');
  });

  it('malformed limits (bulkCap:99999 > max 1000) reverts ONLY limits; valid messaging + notifications survive', () => {
    const s = resolveOrgSettings({
      limits: { bulkCap: 99999 }, // out of range
      messaging: { templates: { welcome: { body: 'ברוך הבא' } } }, // valid
      notifications: { defaultChannels: ['in_app', 'email'] }, // valid
    });
    // limits reverted to default (both leaves):
    expect(s.limits.bulkCap).toBe(200);
    expect(s.limits.defaultPageSize).toBe(25);
    // valid sibling namespaces survive verbatim:
    expect(s.messaging.templates).toEqual({ welcome: { body: 'ברוך הבא' } });
    expect(s.notifications.defaultChannels).toEqual(['in_app', 'email']);
  });

  it('TWO malformed namespaces revert independently; the one valid sibling between them survives', () => {
    const s = resolveOrgSettings({
      signatures: { linkTtlDays: 'abc' }, // malformed → reverts
      limits: { bulkCap: 0 }, // malformed (min 1) → reverts
      locale: 'ar', // valid → survives
    });
    expect(s.signatures.linkTtlDays).toBe(7);
    expect(s.limits.bulkCap).toBe(200);
    expect(s.locale).toBe('ar'); // the lone valid override is preserved
  });

  it('malformed signatures.channels (contains an invalid enum member) reverts the signatures namespace, sibling locale survives', () => {
    const s = resolveOrgSettings({
      locale: 'en',
      signatures: { channels: ['sms', 'carrier-pigeon'] }, // invalid enum value
    });
    expect(s.locale).toBe('en');
    expect(s.signatures.channels).toEqual(['sms', 'email', 'whatsapp']);
    expect(s.signatures.linkTtlDays).toBe(7);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3c. Top-level non-object → ALL defaults (the outermost `.catch`).
//
// Per-namespace fallback is for a malformed namespace INSIDE a valid object.
// A top-level non-object (scalar / array / null) hits the schema's outermost
// `.catch(() => DEFAULT_ORG_SETTINGS)` and yields the WHOLE default tree.
// ───────────────────────────────────────────────────────────────────────────
describe('resolveOrgSettings — top-level non-object → all defaults (outermost catch)', () => {
  it('top-level array → full default tree (no partial survival)', () => {
    expectIsFullDefault(resolveOrgSettings([{ locale: 'en' }] as unknown));
  });

  it('top-level scalar string → full default tree', () => {
    expectIsFullDefault(resolveOrgSettings('en' as unknown));
  });

  it('top-level number → full default tree', () => {
    expectIsFullDefault(resolveOrgSettings(7 as unknown));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Fully-valid custom override round-trips
// ───────────────────────────────────────────────────────────────────────────
describe('resolveOrgSettings — valid custom override round-trips', () => {
  it('a fully-populated valid settings object is preserved verbatim', () => {
    const custom = {
      notifications: { defaultChannels: ['in_app', 'email'] as const },
      messaging: { templates: { welcome: { subject: 'שלום', body: 'ברוך הבא {{name}}' } } },
      branding: { senderName: 'Urban Renew', emailFrom: 'noreply@renew.co.il' },
      locale: 'ar' as const,
      timezone: 'Europe/London',
      signatures: { linkTtlDays: 30, channels: ['email', 'sms'] as const },
      consent: { tama38_1: 50, tama38_2: 70, pinui_binui: 90 },
      limits: { bulkCap: 500, defaultPageSize: 100 },
    };
    const s = resolveOrgSettings(custom);
    expect(s.notifications.defaultChannels).toEqual(['in_app', 'email']);
    expect(s.messaging.templates).toEqual({
      welcome: { subject: 'שלום', body: 'ברוך הבא {{name}}' },
    });
    expect(s.branding.senderName).toBe('Urban Renew');
    expect(s.branding.emailFrom).toBe('noreply@renew.co.il');
    expect(s.locale).toBe('ar');
    expect(s.timezone).toBe('Europe/London');
    expect(s.signatures.linkTtlDays).toBe(30);
    expect(s.signatures.channels).toEqual(['email', 'sms']);
    expect(s.consent).toEqual({ tama38_1: 50, tama38_2: 70, pinui_binui: 90 });
    expect(s.limits).toEqual({ bulkCap: 500, defaultPageSize: 100 });
  });

  it('boundary-valid leaves at their min/max edges round-trip', () => {
    const s = resolveOrgSettings({
      signatures: { linkTtlDays: 90 }, // max
      limits: { bulkCap: 1, defaultPageSize: 1 }, // mins
      consent: { tama38_1: 0, tama38_2: 100, pinui_binui: 0 }, // edges
    });
    expect(s.signatures.linkTtlDays).toBe(90);
    expect(s.limits.bulkCap).toBe(1);
    expect(s.limits.defaultPageSize).toBe(1);
    expect(s.consent).toEqual({ tama38_1: 0, tama38_2: 100, pinui_binui: 0 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. No mutation of the shared DEFAULT_ORG_SETTINGS reference
// ───────────────────────────────────────────────────────────────────────────
describe('resolveOrgSettings — DEFAULT_ORG_SETTINGS is never mutated', () => {
  it('resolving an override does not mutate the exported default tree', () => {
    const before = structuredClone(DEFAULT_ORG_SETTINGS);
    const s = resolveOrgSettings({
      locale: 'en',
      signatures: { linkTtlDays: 3, channels: ['email'] },
      limits: { bulkCap: 999 },
    });
    // the override took effect on the RESULT…
    expect(s.locale).toBe('en');
    expect(s.signatures.linkTtlDays).toBe(3);
    // …but the shared default object is byte-for-byte unchanged.
    expect(DEFAULT_ORG_SETTINGS).toEqual(before);
    expect(DEFAULT_ORG_SETTINGS.signatures.linkTtlDays).toBe(7);
    expect(DEFAULT_ORG_SETTINGS.signatures.channels).toEqual(['sms', 'email', 'whatsapp']);
    expect(DEFAULT_ORG_SETTINGS.limits.bulkCap).toBe(200);
    expect(DEFAULT_ORG_SETTINGS.locale).toBe('he');
  });

  it('mutating a resolved result does not bleed into the default (no shared array/object refs)', () => {
    const s = resolveOrgSettings({});
    // result equals default by value, but must not SHARE the array reference
    expect(s.signatures.channels).not.toBe(DEFAULT_ORG_SETTINGS.signatures.channels);
    s.signatures.channels.push('email');
    s.limits.bulkCap = -1;
    expect(DEFAULT_ORG_SETTINGS.signatures.channels).toEqual(['sms', 'email', 'whatsapp']);
    expect(DEFAULT_ORG_SETTINGS.limits.bulkCap).toBe(200);
  });

  it('two independent resolve calls do not share nested references', () => {
    const a = resolveOrgSettings({});
    const b = resolveOrgSettings({});
    a.consent.tama38_1 = 1;
    expect(b.consent.tama38_1).toBe(66);
  });
});
