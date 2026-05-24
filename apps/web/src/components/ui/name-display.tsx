/**
 * NameDisplay — renders a user-supplied / wire-supplied name string
 * wrapped in `<bdi>` so embedded RTL/LTR override marks (U+202E
 * RLO, U+2066 LRI, U+2067 RLI, …) cannot "escape" the element and
 * spoof neighboring UI text.
 *
 * Closes §v9-H-3 (Agent A 4.3 + ISO A.14).
 *
 * Use for any text whose content originated from a user (Manager
 * entered, Excel imported, OTP-authenticated tenant typed). NOT
 * needed for hard-coded labels from i18n messages.
 */
import { cn } from '@/lib/utils';

export interface NameDisplayProps {
  name: string;
  className?: string;
  /** When true, render as `<bdi>` directly with no extra element wrapper.
   *  Default false → render as `<span><bdi>name</bdi></span>` so callers
   *  can pass className for layout without coupling to the bdi element. */
  bare?: boolean;
}

export function NameDisplay({ name, className, bare = false }: NameDisplayProps) {
  if (bare) {
    return <bdi className={className}>{name}</bdi>;
  }
  return (
    <span className={cn(className)}>
      <bdi>{name}</bdi>
    </span>
  );
}
