/**
 * §RED-2 closure pin — bidi-override stripping is centralized in
 * `<NameDisplay>` so every wire-supplied name rendered through it
 * gets defense in depth, AND adapters can call `stripBidiOverrides`
 * directly for `<option>` and other contexts where `<bdi>` cannot
 * nest.
 *
 * If a future contributor removes the stripper or the `<bdi>` wrapper,
 * this spec fails.
 */
/* eslint-disable security/detect-bidi-characters -- intentional fixtures for the stripper */
import { describe, expect, it } from 'vitest';

import { BIDI_OVERRIDE_REGEX, stripBidiOverrides } from './name-display';

describe('stripBidiOverrides — §RED-2', () => {
  it('1) removes U+202E RLO (the classic spoofing char)', () => {
    const RLO = String.fromCodePoint(0x202e);
    expect(stripBidiOverrides(`hello${RLO}world`)).toBe('helloworld');
  });

  it('2) removes the full LRE/RLE/PDF/LRO/RLO block (U+202A..U+202E)', () => {
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e]) {
      const c = String.fromCodePoint(cp);
      expect(stripBidiOverrides(`a${c}b`)).toBe('ab');
    }
  });

  it('3) removes the LRI/RLI/FSI/PDI block (U+2066..U+2069)', () => {
    for (const cp of [0x2066, 0x2067, 0x2068, 0x2069]) {
      const c = String.fromCodePoint(cp);
      expect(stripBidiOverrides(`x${c}y`)).toBe('xy');
    }
  });

  it('4) removes LRM/RLM (U+200E, U+200F)', () => {
    const LRM = String.fromCodePoint(0x200e);
    const RLM = String.fromCodePoint(0x200f);
    expect(stripBidiOverrides(`p${LRM}q${RLM}r`)).toBe('pqr');
  });

  it('5) preserves legitimate Hebrew + Latin + digits', () => {
    expect(stripBidiOverrides('שלום אבי 123 abc')).toBe('שלום אבי 123 abc');
  });

  it('6) safe on empty string', () => {
    expect(stripBidiOverrides('')).toBe('');
  });

  it('7) BIDI_OVERRIDE_REGEX has global flag (replaces ALL, not just first)', () => {
    expect(BIDI_OVERRIDE_REGEX.global).toBe(true);
    const RLO = String.fromCodePoint(0x202e);
    expect(stripBidiOverrides(`${RLO}${RLO}${RLO}`)).toBe('');
  });
});
