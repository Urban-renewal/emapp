/**
 * Bidi-override stripping — pure utility (no React).
 *
 * Lives in `lib/` so adapters (which can't import from `components/`)
 * can use the same definition. `components/ui/name-display.tsx`
 * re-exports for back-compat.
 *
 * Threat-model linkage (§v9-H-3 / §RED-2 / ISO A.14):
 *  - Security: the codepoints below let an attacker reverse rendering
 *    direction of arbitrary downstream text. Classic use is filename
 *    spoofing (`evil.exe` → `evil.cod`); on multi-tenant UI it's a
 *    cross-record spoof (e.g. owner name "John" embeds RLO so the
 *    NEXT cell renders backwards).
 *  - Performance: single linear regex pass; <1µs on typical strings.
 *  - Error handling: returns the cleaned string; never throws.
 *    Caller can pass `undefined`/`null` only at TypeScript's allowance.
 *
 * Why two layers (this stripper + `<bdi>` isolate):
 *  - The `<bdi>` element is the SPEC-correct defense — it isolates
 *    whatever appears inside from neighbouring text. BUT some HTML
 *    elements (notably `<option>`, `<title>`, `<textarea>`) CANNOT
 *    contain `<bdi>` (browsers strip the inner element). For those
 *    elements, the text-level strip below IS the only line of defense.
 *  - For other elements, the stripper is belt-and-braces — even if a
 *    future refactor forgets the `<bdi>` wrap, the codepoint is
 *    already gone.
 */

/**
 * Codepoints stripped:
 *  - U+202A LRE, U+202B RLE, U+202C PDF, U+202D LRO, U+202E RLO
 *  - U+2066 LRI, U+2067 RLI, U+2068 FSI, U+2069 PDI
 *  - U+200E LRM, U+200F RLM (less dangerous but rarely intended)
 *
 * Written with `\u` escapes (NOT literal code points) so the file
 * itself doesn't trigger eslint-plugin-security/detect-bidi-characters
 * and so a code reviewer reading this file sees ranges, not invisible
 * characters.
 */
// eslint-disable-next-line security/detect-bidi-characters -- intentional: stripper definition
export const BIDI_OVERRIDE_REGEX = /[‪-‮⁦-⁩‎‏]/g;

export function stripBidiOverrides(s: string): string {
  return s.replace(BIDI_OVERRIDE_REGEX, '');
}
