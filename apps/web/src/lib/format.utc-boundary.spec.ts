/**
 * P-TZ-1 — proof under a UTC process clock (the CI condition).
 *
 * The whole point of the fix is that formatRelative is correct REGARDLESS
 * of the JS runtime timezone. CI runners are UTC. This spec forces
 * `process.env.TZ = 'UTC'` BEFORE importing the module (so the V8 Date
 * default-zone is UTC for this file) and asserts the Israel-correct
 * relative strings on the exact instants from format.spec.ts T-TZ-1.A/B.
 *
 * If formatRelative ever regresses to a runtime-TZ-dependent diff, this
 * file fails on a UTC host even when the main spec (run on a +0200/+0300
 * dev box) still passes — that's the regression guard.
 */
import { beforeAll, describe, expect, it } from 'vitest';

// Pin the process zone to UTC before the module under test is evaluated.
process.env.TZ = 'UTC';

describe('formatRelative under process.env.TZ=UTC (CI parity)', () => {
  // Lazy import so the TZ pin above is in effect when format.ts loads.
  let formatRelative: (typeof import('./format'))['formatRelative'];

  beforeAll(async () => {
    ({ formatRelative } = await import('./format'));
  });

  it('T-TZ-1.A@UTC) same Israel civil day is NOT "yesterday" on a UTC runtime', () => {
    const target = new Date('2026-06-15T21:00:00Z'); // IL 2026-06-16 00:00
    const now = new Date('2026-06-16T20:00:00Z'); // IL 2026-06-16 23:00
    expect(process.env.TZ).toBe('UTC');
    expect(formatRelative(target, 'he', now)).toBe('לפני 23 שעות');
    expect(formatRelative(target, 'he', now)).not.toBe('אתמול');
  });

  it('T-TZ-1.B@UTC) crossing Israel midnight IS "yesterday" on a UTC runtime', () => {
    const target = new Date('2026-06-16T20:30:00Z'); // IL 2026-06-16 23:30
    const now = new Date('2026-06-16T21:30:00Z'); // IL 2026-06-17 00:30
    expect(formatRelative(target, 'he', now)).toBe('אתמול');
  });
});
