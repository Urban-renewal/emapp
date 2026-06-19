import { cn } from '@/lib/utils';

/**
 * Skeleton — the base shimmer placeholder primitive (E2 Wave-0 C2).
 *
 * A single token-colored block carrying the `.skeleton` class (defined in
 * `globals.css`). The shimmer is CSS-only (no JS animation loop) and its
 * duration is the `--motion-duration-slow` token, so the global
 * `prefers-reduced-motion` guard zeroes it automatically — ZERO motion under
 * reduce, no per-component media query. Color comes from tokens only, so the
 * inline-color ratchet stays green and a re-skin re-tunes it from globals.css.
 *
 * Usage:
 *   <Skeleton className="h-7 w-48" />
 *   <Skeleton className="h-20 w-full" />
 */
export interface SkeletonProps {
  /** Tailwind sizing/spacing classes (height/width/radius). Token colors
   *  come from `.skeleton`; callers pass geometry only. */
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return <div aria-hidden="true" className={cn('skeleton', className)} />;
}
