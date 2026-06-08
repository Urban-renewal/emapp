/**
 * Bidi-reorder unit proof — the LOAD-BEARING, deterministic layer behind the
 * signed-certificate PDF (no DB, no env, no R2).
 *
 * Context: pdf-lib has no native bidi. The renderer must hand pdf-lib characters
 * in VISUAL (left-to-right draw) order. The OLD code did a hand-rolled
 * single-level `[...text].reverse()`; that garbles real mixed content because it
 * reverses digit/Latin runs that the Unicode Bidi Algorithm (UBA) must keep
 * left-to-right inside RTL text. `bidi-reorder.ts` runs the real UBA via bidi-js.
 *
 * These tests pin the UBA-correct VISUAL output and are MUTATION-PROOF against
 * the naive reverse: each "vs naive" assertion below FAILS if the implementation
 * is replaced by `[...text].reverse()`. The single exception (documented inline)
 * is pure-Hebrew "שלום", whose visual order is reverse — so it is NOT load-bearing
 * for the mutation proof and only pins the reversal-of-pure-Hebrew contract.
 *
 * Expected visual strings below were derived empirically from bidi-js, then
 * frozen here as the regression oracle.
 */
import { describe, expect, it } from 'vitest';

import { splitVisualRuns, toVisualOrder, toVisualRuns } from './bidi-reorder';

/** The OLD, buggy logic this module replaced. Kept ONLY as the mutation oracle:
 *  every load-bearing assertion asserts the real output DIFFERS from this. */
const naiveReverse = (s: string): string => [...s].reverse().join('');

describe('toVisualOrder — UBA logical→visual (RTL base)', () => {
  it('keeps an embedded number LTR and contiguous inside RTL Hebrew ("דירה 12")', () => {
    const visual = toVisualOrder('דירה 12');

    // The Hebrew word reorders RTL, but the digits MUST stay "12" (reading
    // order), NOT "21". This is the canonical bug the old reverse caused.
    expect(visual).toBe('12 הריד');
    expect(visual).toContain('12');
    expect(visual).not.toContain('21');
    // The digit pair is a single contiguous run (not split by reordering).
    expect(visual.indexOf('1')).toBe(visual.indexOf('12'));
    expect(visual.indexOf('2')).toBe(visual.indexOf('12') + 1);

    // MUTATION PROOF: naive reverse would yield "21 הריד" — digits flipped.
    expect(naiveReverse('דירה 12')).toBe('21 הריד');
    expect(visual).not.toBe(naiveReverse('דירה 12'));
  });

  it('preserves a 9-digit national_id as a contiguous LTR run inside Hebrew', () => {
    const logical = 'מספר זהות 123456789 של הבעלים';
    const visual = toVisualOrder(logical);

    // The id must read left-to-right, unreversed, as one block.
    expect(visual).toContain('123456789');
    expect(visual).not.toContain('987654321');
    // Frozen full-visual oracle (Hebrew runs reversed, id LTR in the middle).
    expect(visual).toBe('םילעבה לש 123456789 תוהז רפסמ');

    // MUTATION PROOF: naive reverse flips the id to 987654321 — a real-data
    // corruption (a national_id printed backwards on a legal certificate).
    expect(naiveReverse(logical)).toContain('987654321');
    expect(visual).not.toBe(naiveReverse(logical));
  });

  it('reverses pure Hebrew to visual order ("שלום" → "םולש")', () => {
    // Pure RTL: visual order IS the reverse. This pins the reversal contract
    // but is intentionally NOT part of the mutation proof (naive reverse agrees
    // here) — see file header.
    const visual = toVisualOrder('שלום');
    expect(visual).toBe('םולש');
    expect(visual).toBe(naiveReverse('שלום')); // documented: equal for pure Hebrew
  });

  it('leaves pure ASCII unchanged ("Apartment 5")', () => {
    const logical = 'Apartment 5';
    const visual = toVisualOrder(logical);

    // LTR content under an RTL base direction must NOT be reordered.
    expect(visual).toBe('Apartment 5');

    // MUTATION PROOF: naive reverse would garble it to "5 tnemtrapA".
    expect(naiveReverse(logical)).toBe('5 tnemtrapA');
    expect(visual).not.toBe(naiveReverse(logical));
  });

  it('handles a Hebrew address with a house number ("רחוב הרצל 5")', () => {
    const visual = toVisualOrder('רחוב הרצל 5');
    // House number stays "5" (single digit; contiguity trivially holds) and the
    // Hebrew words reorder RTL. Full frozen oracle:
    expect(visual).toBe('5 לצרה בוחר');
    expect(visual).toContain('5');
    // The Hebrew run is reversed relative to logical input.
    expect(visual.startsWith('5')).toBe(true);
  });

  it('mirrored-pair: parentheses wrap survives reordering ("(שלום)")', () => {
    // NOTE ON SCOPE: for a SYMMETRIC bracket pair around an RTL word, the
    // visual output ")םולש(" is identical to a naive reverse, because reversing
    // "(שלום)" also yields ")םולש(". bidi-js's mirroring map is empty for this
    // input on this platform, so a glyph-mirror assertion distinct from reverse
    // is NOT reliably observable here. We therefore assert the most reliable
    // observable — the bracket characters survive and bracket the Hebrew word —
    // and explicitly do NOT claim this case as part of the mutation proof.
    const visual = toVisualOrder('(שלום)');
    expect(visual).toContain('(');
    expect(visual).toContain(')');
    expect(visual).toContain('םולש'); // the Hebrew word is reversed (visual)
    // The wrap is preserved: one paren on each side of the Hebrew run.
    const open = visual.indexOf('(');
    const close = visual.indexOf(')');
    const heb = visual.indexOf('םולש');
    expect(heb).toBeGreaterThan(-1);
    expect(Math.min(open, close)).toBeLessThan(heb);
    expect(Math.max(open, close)).toBeGreaterThan(heb);
  });

  it('is a no-op on the empty string', () => {
    expect(toVisualOrder('')).toBe('');
  });
});

describe('splitVisualRuns / toVisualRuns — script segmentation for font choice', () => {
  it('segments a visual mixed string into Hebrew (Heebo) and non-Hebrew runs', () => {
    // Drives font selection: heb=true → embedded Heebo subset; else Helvetica.
    const runs = toVisualRuns('דירה 12');
    // Reassembling the runs must reproduce the visual string exactly (no glyph
    // dropped or reordered by segmentation).
    expect(runs.map((r) => r.text).join('')).toBe('12 הריד');

    // The Hebrew letters route to the Heebo run; digits/space route to non-Heebo
    // (Helvetica) — the Heebo subset has no Latin/digit glyphs.
    const hebText = runs
      .filter((r) => r.heb)
      .map((r) => r.text)
      .join('');
    const nonHebText = runs
      .filter((r) => !r.heb)
      .map((r) => r.text)
      .join('');
    expect(hebText).toBe('הריד');
    expect(nonHebText).toContain('12');
    // Digits are NEVER on the Heebo run (would render as .notdef / blank).
    expect(hebText).not.toMatch(/\d/);
  });

  it('routes a national_id to a non-Hebrew run (drawn with Helvetica)', () => {
    const runs = toVisualRuns('מספר זהות 123456789 של הבעלים');
    const idRun = runs.find((r) => r.text.includes('123456789'));
    expect(idRun).toBeDefined();
    expect(idRun?.heb).toBe(false);
    // The id is intact within its single run (not split across runs).
    expect(idRun?.text).toContain('123456789');
  });

  it('pure Hebrew is a single Heebo run', () => {
    const runs = splitVisualRuns(toVisualOrder('שלום'));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.heb).toBe(true);
    expect(runs[0]?.text).toBe('םולש');
  });

  it('pure ASCII is a single non-Hebrew run, unreversed', () => {
    const runs = toVisualRuns('Apartment 5');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.heb).toBe(false);
    expect(runs[0]?.text).toBe('Apartment 5');
  });
});

describe('robustness — exotic owner names route through the splitter without throwing', () => {
  it('CJK + emoji ("李明 🎉") segments without throwing and stays a non-Hebrew run', () => {
    // The renderer's encodeSafe later degrades these to "?" for Helvetica/Heebo,
    // but the bidi + split layer must never throw on astral chars (emoji is a
    // surrogate pair) or non-Latin scripts.
    expect(() => toVisualRuns('李明 🎉')).not.toThrow();
    const runs = toVisualRuns('李明 🎉');
    expect(runs.every((r) => !r.heb)).toBe(true);
    // No glyph is lost and the emoji code point is not split mid-surrogate.
    const joined = runs.map((r) => r.text).join('');
    expect([...joined]).toContain('🎉');
    expect([...joined]).toContain('李');
  });

  it('does not split an astral code point across the visual reorder', () => {
    // "א🎉ב" — Hebrew + emoji + Hebrew. The emoji must remain a single code
    // point (not two lone surrogates) after reordering.
    const visual = toVisualOrder('א🎉ב');
    expect([...visual]).toContain('🎉');
    // Every code point in the output is a valid (non-surrogate-half) scalar.
    for (const ch of visual) {
      const cp = ch.codePointAt(0)!;
      expect(cp < 0xd800 || cp > 0xdfff).toBe(true);
    }
  });
});
