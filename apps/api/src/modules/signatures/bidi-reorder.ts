import bidiFactory from 'bidi-js';

/**
 * Logical→visual reordering for the pdf-lib certificate renderer.
 *
 * pdf-lib has no native bidi, so when we draw a Hebrew/mixed string we must
 * hand pdf-lib the characters in VISUAL order (the order they appear on screen,
 * left-to-right) and lay them out at increasing x. Previously this module's
 * caller did a hand-rolled single-level bidi (`[...run].reverse()` + manual
 * right-to-left run layout); that is not the Unicode Bidi Algorithm and garbles
 * real mixed content — e.g. "דירה 12" or "רחוב הרצל 5", where digits/Latin must
 * stay left-to-right while the surrounding Hebrew runs right-to-left.
 *
 * Here we run the real UBA via `bidi-js`:
 *   1. resolve embedding levels with an explicit RTL base direction,
 *   2. reverse the resolved segments to get the visual character order,
 *   3. apply RTL character mirroring (parens/brackets) so "(…)" reads right.
 *
 * The result is a visually-ordered string. The renderer then segments THAT
 * string into font-runs by script (the embedded Heebo subset has no Latin
 * glyphs) and draws each run left-to-right. No `.reverse()` in the renderer —
 * bidi-js owns letter and run order; the renderer only maps script→font.
 */

// `bidi` is stateless (the factory exists only to keep the module closure
// self-contained — see the package README), so one shared instance is correct.
const bidi = bidiFactory();

/** A maximal run of same-script characters in VISUAL (left-to-right) order. */
export interface VisualRun {
  text: string;
  /** True when this run is Hebrew and must be drawn with the Heebo font. */
  heb: boolean;
}

/** Unicode Hebrew block (incl. presentation forms are out of scope — the
 *  Heebo subset covers the base block, which is what our content uses). */
function isHebrew(ch: string): boolean {
  return /[֐-׿]/.test(ch);
}

/**
 * Reorder a logical string to visual order using the Unicode Bidi Algorithm
 * with an RTL base direction. Returns the visually-ordered code points joined
 * back into a string (LTR draw order).
 */
export function toVisualOrder(logical: string): string {
  if (logical.length === 0) return logical;
  // Operate on code points so astral characters (emoji etc.) are never split.
  const chars = [...logical];
  const embeddingLevels = bidi.getEmbeddingLevels(logical, 'rtl');

  // RTL mirrored pairs: replace BEFORE reversing, keyed by code-unit index in
  // the original string. Map those indices onto our code-point array.
  const mirrored = bidi.getMirroredCharactersMap(logical, embeddingLevels);
  if (mirrored.size > 0) {
    const cpIndexByCodeUnit = buildCodeUnitToCodePointIndex(logical, chars.length);
    for (const [codeUnitIndex, replacement] of mirrored) {
      const cpIndex = cpIndexByCodeUnit[codeUnitIndex];
      if (cpIndex !== undefined) chars[cpIndex] = replacement;
    }
  }

  // getReorderSegments returns ranges (in code-unit indices) to reverse in
  // place, in order. Translate each range to code-point indices, then reverse.
  const cpIndexByCodeUnit = buildCodeUnitToCodePointIndex(logical, chars.length);
  for (const [startUnit, endUnit] of bidi.getReorderSegments(logical, embeddingLevels)) {
    const start = cpIndexByCodeUnit[startUnit];
    const end = cpIndexByCodeUnit[endUnit];
    if (start === undefined || end === undefined) continue;
    for (let i = start, j = end; i < j; i++, j--) {
      const tmp = chars[i]!;
      chars[i] = chars[j]!;
      chars[j] = tmp;
    }
  }
  return chars.join('');
}

/**
 * Map each UTF-16 code-unit index in `s` to the index of the code point that
 * contains it. bidi-js reports indices in code units; we store text as code
 * points so astral chars stay intact. For BMP-only strings this is the
 * identity map; it only differs when surrogate pairs are present.
 */
function buildCodeUnitToCodePointIndex(s: string, codePointCount: number): number[] {
  const map: number[] = new Array(s.length);
  let cpIndex = 0;
  for (let unit = 0; unit < s.length; ) {
    const cp = s.codePointAt(unit)!;
    const width = cp > 0xffff ? 2 : 1;
    for (let k = 0; k < width; k++) map[unit + k] = cpIndex;
    unit += width;
    cpIndex++;
  }
  // Defensive: if counts disagree (they shouldn't), clamp to the last cp.
  if (cpIndex !== codePointCount) {
    for (let i = 0; i < map.length; i++) {
      if (map[i] === undefined || map[i]! >= codePointCount) map[i] = codePointCount - 1;
    }
  }
  return map;
}

/**
 * Split a VISUALLY-ORDERED string into maximal same-script runs, preserving
 * left-to-right draw order. Call `toVisualOrder` first. The split is by
 * Hebrew vs. non-Hebrew because the embedded Heebo font is a Hebrew subset
 * (no Latin/digit glyphs) — the renderer picks Heebo for `heb` runs and
 * Helvetica for the rest.
 */
export function splitVisualRuns(visual: string): VisualRun[] {
  const runs: VisualRun[] = [];
  for (const ch of visual) {
    const heb = isHebrew(ch);
    const last = runs[runs.length - 1];
    if (last && last.heb === heb) last.text += ch;
    else runs.push({ text: ch, heb });
  }
  return runs;
}

/** Convenience: logical string → visually-ordered font runs (LTR draw order). */
export function toVisualRuns(logical: string): VisualRun[] {
  return splitVisualRuns(toVisualOrder(logical));
}
