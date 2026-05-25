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
import { BIDI_OVERRIDE_REGEX, stripBidiOverrides } from '@/lib/bidi';
import { cn } from '@/lib/utils';

// Re-export the bidi utilities for back-compat — adapters + tests
// historically imported them from this component file. New code should
// prefer `@/lib/bidi` directly (no React dependency).
export { BIDI_OVERRIDE_REGEX, stripBidiOverrides };

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
