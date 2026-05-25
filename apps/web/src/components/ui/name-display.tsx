/**
 * NameDisplay — renders a user-supplied / wire-supplied name string
 * wrapped in `<bdi>` so embedded RTL/LTR override marks (U+202E RLO,
 * U+2066 LRI, U+2067 RLI, …) cannot "escape" the element and spoof
 * neighboring UI text.
 *
 * Closes §v9-H-3 + §RED-2 (Agent A 4.3 + ISO A.14).
 *
 * Defense in depth — three layers:
 *  1. `stripBidiOverrides` removes the dangerous code points entirely
 *     (the BE may sanitise too; we don't trust that).
 *  2. `<bdi>` element isolates whatever survives.
 *  3. Adapters can optionally pre-strip at the data layer; this
 *     component still strips again at render so a forgotten adapter
 *     isn't fatal.
 *
 * Use for any text whose content originated from a user (Manager
 * entered, Excel imported, OTP-authenticated tenant typed). NOT
 * needed for hard-coded labels from i18n messages.
 */
import { cn } from '@/lib/utils';

/**
 * Strip Unicode bidi/embedding override code points that an attacker
 * could use to spoof rendering:
 *  - U+202A LRE, U+202B RLE, U+202C PDF, U+202D LRO, U+202E RLO
 *  - U+2066 LRI, U+2067 RLI, U+2068 FSI, U+2069 PDI
 *  - U+200E LRM, U+200F RLM (less dangerous but rarely intended)
 *
 * Exported so adapters and tests can use the same definition.
 *
 * Written with `\u` escapes (NOT literal code points) so the file
 * itself doesn't trigger eslint-plugin-security/detect-bidi-characters
 * (and so a code reviewer reading this file sees ranges, not invisible
 * characters).
 */
// eslint-disable-next-line security/detect-bidi-characters -- intentional: stripper definition
export const BIDI_OVERRIDE_REGEX = /[‪-‮⁦-⁩‎‏]/g;

export function stripBidiOverrides(s: string): string {
  return s.replace(BIDI_OVERRIDE_REGEX, '');
}

export interface NameDisplayProps {
  name: string;
  className?: string;
  /** When true, render as `<bdi>` directly with no extra element wrapper.
   *  Default false → render as `<span><bdi>name</bdi></span>` so callers
   *  can pass className for layout without coupling to the bdi element. */
  bare?: boolean;
}

export function NameDisplay({ name, className, bare = false }: NameDisplayProps) {
  const safe = stripBidiOverrides(name);
  if (bare) {
    return <bdi className={className}>{safe}</bdi>;
  }
  return (
    <span className={cn(className)}>
      <bdi>{safe}</bdi>
    </span>
  );
}
