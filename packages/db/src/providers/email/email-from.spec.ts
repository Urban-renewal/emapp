/**
 * Adversarial unit tests for `buildEmailFrom` (P6 — wire branding.senderName
 * into the email From display-name). Authored by a separate TEST-AUTHOR — these
 * tests do NOT trust the builder.
 *
 * The function builds a SECURITY-RELEVANT RFC 5322 `From` header from
 * org-controlled input (`branding.senderName`). The two load-bearing invariants:
 *
 *   1. HEADER INJECTION is impossible — no CR/LF, no control chars, no specials
 *      that could split the header or inject a `Bcc:`/`Cc:` can survive into the
 *      output (test "header injection").
 *   2. The From ADDRESS is ALWAYS the verified system address — there is NO
 *      input by which an org can change the sender address (test "no custom
 *      address"). An email-shaped senderName must NOT become the address.
 *
 * Pure: no DB, no network, no env mutation. All control chars are built at
 * RUNTIME (String.fromCharCode) so no raw CR/LF/control bytes trip lint.
 */
import { describe, expect, it } from 'vitest';

import { buildEmailFrom, DEFAULT_EMAIL_FROM } from './email-from';

const SYSTEM = 'EMAPP <no-reply@emapp.co.il>';
const BARE = 'no-reply@emapp.co.il';
const ADDR = 'no-reply@emapp.co.il';

// Runtime-built control sequences — never paste raw control bytes (lint).
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;
const DEL = String.fromCharCode(127);
const NUL = String.fromCharCode(0);

describe('buildEmailFrom — happy path', () => {
  it('applies the display name and PRESERVES the verified address', () => {
    expect(buildEmailFrom('Acme Renewal', SYSTEM)).toBe('Acme Renewal <no-reply@emapp.co.il>');
  });

  it('keeps Hebrew display names intact (only specials/controls are stripped)', () => {
    // Israeli urban-renewal org name — non-ASCII letters must survive.
    expect(buildEmailFrom('התחדשות עירונית', SYSTEM)).toBe(
      'התחדשות עירונית <no-reply@emapp.co.il>',
    );
  });
});

describe('buildEmailFrom — header injection (LOAD-BEARING, exhaustive)', () => {
  // Each input is an attempted injection. For ALL of them we assert:
  //   - output contains NO CR and NO LF (header cannot be split)
  //   - the address segment is EXACTLY `<no-reply@emapp.co.il>` (verified addr)
  //   - no `Bcc:`/`Cc:` (or any second address) is injectable
  const injections: Array<{ name: string; input: string }> = [
    { name: 'CRLF + Bcc', input: 'Acme' + CRLF + 'Bcc: attacker@evil.com' },
    { name: 'LF + Cc', input: 'Acme' + LF + 'Cc: x@y.com' },
    { name: 'bare CR', input: 'Acme' + CR + 'Bcc: a@b.com' },
    { name: 'angle-bracket script tag', input: 'Acme<script>' },
    { name: 'quote + angle address', input: 'Acme"<evil@evil.com>' },
    { name: 'email-shaped name', input: 'a@b.com' },
    { name: 'NUL byte', input: 'Ac' + NUL + 'me' },
    { name: 'DEL byte', input: 'Ac' + DEL + 'me' },
    { name: 'U+2028 line separator', input: 'Ac' + String.fromCharCode(0x2028) + 'me' },
    { name: 'U+2029 paragraph separator', input: 'Ac' + String.fromCharCode(0x2029) + 'me' },
  ];

  for (const { name, input } of injections) {
    it(`neutralizes: ${name}`, () => {
      const out = buildEmailFrom(input, SYSTEM);
      // No newline of any kind survived.
      expect(out).not.toContain(CR);
      expect(out).not.toContain(LF);
      expect(out.includes('\r')).toBe(false);
      expect(out.includes('\n')).toBe(false);
      // The verified address is present, EXACTLY, in angle brackets.
      expect(out).toContain('<no-reply@emapp.co.il>');
      // No injected header keyword leaked through (case-insensitive).
      expect(out.toLowerCase()).not.toContain('bcc:');
      expect(out.toLowerCase()).not.toContain('cc:');
      // No attacker address leaked.
      expect(out).not.toContain('attacker@evil.com');
      expect(out).not.toContain('evil@evil.com');
      expect(out).not.toContain('x@y.com');
      // EXACTLY one '<' and one '>' — the address brackets, nothing extra.
      expect((out.match(/</g) ?? []).length).toBe(1);
      expect((out.match(/>/g) ?? []).length).toBe(1);
      // The address segment is precisely the verified address (the part after
      // the LAST space is `<addr>`).
      const tail = out.slice(out.lastIndexOf('<'));
      expect(tail).toBe('<no-reply@emapp.co.il>');
    });
  }

  it('strips EACH RFC 5322 special individually (none survive)', () => {
    const specials = ['"', '<', '>', '(', ')', ',', ':', ';', '\\', '@', '[', ']'];
    for (const sp of specials) {
      const out = buildEmailFrom(`Ac${sp}me`, SYSTEM);
      // The special must not appear in the DISPLAY-NAME portion.
      const display = out.slice(0, out.lastIndexOf('<')).trimEnd();
      expect(display).toBe('Acme');
      expect(display).not.toContain(sp);
      // Address still intact.
      expect(out).toBe('Acme <no-reply@emapp.co.il>');
    }
  });

  it('strips ALL specials at once and falls back when nothing safe remains', () => {
    const allSpecials = '"<>(),:;\\@[]';
    // Every char is a special → sanitizes to '' → fallback to systemFrom.
    expect(buildEmailFrom(allSpecials, SYSTEM)).toBe(SYSTEM);
  });
});

describe('buildEmailFrom — custom address is NOT honored (LOAD-BEARING)', () => {
  it('an email-shaped senderName never becomes the From address', () => {
    const out = buildEmailFrom('x@evil.com', SYSTEM);
    // The `@` is stripped → display name becomes `xevil.com`, address unchanged.
    expect(out).toBe('xevil.com <no-reply@emapp.co.il>');
    expect(out).not.toContain('@evil.com');
    // The ONLY `@` in the output is inside the verified address.
    expect((out.match(/@/g) ?? []).length).toBe(1);
    expect(out.slice(out.lastIndexOf('<'))).toBe('<no-reply@emapp.co.il>');
  });

  it('a full display-form senderName cannot smuggle a second address', () => {
    const out = buildEmailFrom('Evil <attacker@evil.com>', SYSTEM);
    expect(out).not.toContain('attacker@evil.com');
    expect(out).not.toContain('@evil.com');
    expect(out.slice(out.lastIndexOf('<'))).toBe('<no-reply@emapp.co.il>');
  });

  it('the helper signature has NO parameter for a custom from-address', () => {
    // buildEmailFrom(senderName, systemFrom) — exactly 2 params. A third
    // (custom-address) param would be a spoofing vector; assert it cannot exist.
    expect(buildEmailFrom.length).toBe(2);
  });
});

describe('buildEmailFrom — empty / blank / all-stripped fallback', () => {
  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['all spaces', '   '],
    ['CRLF only', CRLF],
    ['tabs/newlines mix', '\t' + LF + ' ' + CR],
    ['only quotes (all specials)', '"""'],
    ['only control bytes', NUL + DEL + String.fromCharCode(1, 2, 3)],
  ])('returns systemFrom EXACTLY unchanged for %s', (_label, input) => {
    expect(buildEmailFrom(input, SYSTEM)).toBe(SYSTEM);
  });

  it('fallback preserves a BARE-address systemFrom verbatim too', () => {
    expect(buildEmailFrom('', BARE)).toBe(BARE);
    expect(buildEmailFrom(undefined, BARE)).toBe(BARE);
  });
});

describe('buildEmailFrom — length cap', () => {
  it('caps the display name at 120 chars; address still present + correct', () => {
    const long = 'A'.repeat(500);
    const out = buildEmailFrom(long, SYSTEM);
    const display = out.slice(0, out.lastIndexOf('<')).trimEnd();
    expect(display.length).toBe(120);
    expect(display).toBe('A'.repeat(120));
    expect(out).toBe('A'.repeat(120) + ' <no-reply@emapp.co.il>');
    expect(out.slice(out.lastIndexOf('<'))).toBe('<no-reply@emapp.co.il>');
  });

  it('counts chars AFTER stripping (specials/controls do not pad the cap)', () => {
    // 120 'B' interleaved with stripped specials → still exactly 120 'B'.
    const noisy = 'B@'.repeat(200); // 200 B's, each followed by a stripped @
    const out = buildEmailFrom(noisy, SYSTEM);
    const display = out.slice(0, out.lastIndexOf('<')).trimEnd();
    expect(display).toBe('B'.repeat(120));
  });
});

describe('buildEmailFrom — systemFrom address extraction (both forms)', () => {
  it('extracts the address from a DISPLAY form', () => {
    expect(buildEmailFrom('Acme', 'EMAPP <no-reply@emapp.co.il>')).toBe(
      'Acme <no-reply@emapp.co.il>',
    );
  });

  it('extracts the address from a BARE address', () => {
    expect(buildEmailFrom('Acme', BARE)).toBe('Acme <no-reply@emapp.co.il>');
  });

  it('uses the LAST <…> when systemFrom has a stray bracket', () => {
    // Defensive: the verified address is whatever is in the final <…>.
    expect(buildEmailFrom('Acme', 'Weird <x> <no-reply@emapp.co.il>')).toBe(
      'Acme <no-reply@emapp.co.il>',
    );
  });

  it('both forms agree on the extracted ADDRESS', () => {
    const fromDisplay = buildEmailFrom('Acme', SYSTEM);
    const fromBare = buildEmailFrom('Acme', BARE);
    const addrOf = (s: string): string => s.slice(s.lastIndexOf('<'));
    expect(addrOf(fromDisplay)).toBe('<' + ADDR + '>');
    expect(addrOf(fromBare)).toBe(addrOf(fromDisplay));
  });
});

describe('DEFAULT_EMAIL_FROM (sanity — the baked verified default)', () => {
  it('is a non-empty string usable as systemFrom', () => {
    expect(typeof DEFAULT_EMAIL_FROM).toBe('string');
    expect(DEFAULT_EMAIL_FROM.length).toBeGreaterThan(0);
    // Building from it never throws and yields a single address segment.
    const out = buildEmailFrom('Acme', DEFAULT_EMAIL_FROM);
    expect((out.match(/</g) ?? []).length).toBe(1);
    expect((out.match(/>/g) ?? []).length).toBe(1);
  });
});
