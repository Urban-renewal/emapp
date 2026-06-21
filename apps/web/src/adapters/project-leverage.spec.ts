/**
 * Battle-Map BM-1 — leverage card adapter (Wire → ViewModel) + READ-ONLY guard.
 *
 * The dev environment ships no `@testing-library/react` stack, so (per the
 * `.spec.ts` convention, e.g. export-xlsx-button.spec.ts) the card's React
 * render is exercised by the orchestrator's real-Chrome / Playwright walk. These
 * specs pin the load-bearing PURE layer the render consumes — the adapter — plus
 * a static guard that the card surface stays READ-ONLY (no mutation affordance,
 * the one-tap remind being the separate HB-1 slice).
 *
 * Coverage:
 *   - the top-leverage owner maps through with name + delta/projection + basis,
 *   - the apartment label is `formatApartmentLabel`-deduped (no "דירה דירה N"),
 *   - share % is rounded to a whole percent,
 *   - crossesThreshold passes through,
 *   - the all-clear / nothing-movable state (`leverage: null`),
 *   - the owner name is bidi-stripped + a null/blank name normalises to null,
 *   - national_id / phone never leak (name-only invariant),
 *   - the card component contains NO mutating POST/remind affordance.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProjectLeverageSchema } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { toProjectLeverageViewModel } from './project';

const RLO = String.fromCharCode(0x202e); // right-to-left override — the bidi-spoof codepoint

function leverage(over: Partial<import('@emapp/shared-types').ProjectLeverage> = {}) {
  return ProjectLeverageSchema.parse({
    projectId: '00000000-0000-4000-8000-00000c901001',
    currentPct: 61,
    basis: 'share',
    leverage: {
      ownerId: '11111111-1111-1111-1111-111111111111',
      ownerName: 'דנה כהן',
      apartmentId: '22222222-2222-2222-2222-222222222222',
      apartmentLabel: '4',
      ownerSharePctInApartment: 28.4,
      projectedPct: 71,
      crossesThreshold: true,
    },
    ...over,
  });
}

describe('toProjectLeverageViewModel — BM-1 leverage adapter', () => {
  it('1) maps the headline + the top-leverage owner (name + projection + basis)', () => {
    const vm = toProjectLeverageViewModel(leverage());
    expect(vm.currentPct).toBe(61);
    expect(vm.basis).toBe('share');
    expect(vm.leverage).not.toBeNull();
    expect(vm.leverage!.ownerName).toBe('דנה כהן');
    expect(vm.leverage!.ownerId).toBe('11111111-1111-1111-1111-111111111111');
    expect(vm.leverage!.apartmentId).toBe('22222222-2222-2222-2222-222222222222');
    expect(vm.leverage!.projectedPct).toBe(71);
    expect(vm.leverage!.crossesThreshold).toBe(true);
  });

  it('2) rounds the owner share % to a whole percent', () => {
    expect(toProjectLeverageViewModel(leverage()).leverage!.ownerSharePct).toBe(28);
    const lower = leverage({
      leverage: { ...leverage().leverage!, ownerSharePctInApartment: 28.5 },
    });
    expect(toProjectLeverageViewModel(lower).leverage!.ownerSharePct).toBe(29);
  });

  it('3) formats the apartment label via formatApartmentLabel (prepends "דירה")', () => {
    expect(toProjectLeverageViewModel(leverage()).leverage!.apartmentLabel).toBe('דירה 4');
  });

  it('4) dedups an already-"דירה"-prefixed apartment number (no "דירה דירה")', () => {
    const dup = leverage({ leverage: { ...leverage().leverage!, apartmentLabel: 'דירה 4' } });
    expect(toProjectLeverageViewModel(dup).leverage!.apartmentLabel).toBe('דירה 4');
  });

  it('5) all-clear / nothing-movable → leverage is null (currentPct still maps)', () => {
    const vm = toProjectLeverageViewModel(leverage({ leverage: null, currentPct: 100 }));
    expect(vm.leverage).toBeNull();
    expect(vm.currentPct).toBe(100);
  });

  it('6) below-threshold owner passes crossesThreshold:false through', () => {
    const below = leverage({
      leverage: { ...leverage().leverage!, crossesThreshold: false, projectedPct: 64 },
    });
    const vm = toProjectLeverageViewModel(below);
    expect(vm.leverage!.crossesThreshold).toBe(false);
    expect(vm.leverage!.projectedPct).toBe(64);
  });

  it('7) bidi-strips an owner name carrying an embedded RTL override (spoof defense)', () => {
    const spoof = leverage({ leverage: { ...leverage().leverage!, ownerName: `דנה${RLO}כהן` } });
    const vm = toProjectLeverageViewModel(spoof);
    expect(vm.leverage!.ownerName).not.toContain(RLO);
    expect(vm.leverage!.ownerName).toBe('דנהכהן');
  });

  it('8) normalises a masked (null) owner name to null', () => {
    const masked = leverage({ leverage: { ...leverage().leverage!, ownerName: null } });
    expect(toProjectLeverageViewModel(masked).leverage!.ownerName).toBeNull();
  });

  it('9) normalises a blank/whitespace owner name to null', () => {
    const blank = leverage({ leverage: { ...leverage().leverage!, ownerName: '   ' } });
    expect(toProjectLeverageViewModel(blank).leverage!.ownerName).toBeNull();
  });

  it('10) never surfaces national_id / phone (name-only invariant)', () => {
    const vm = toProjectLeverageViewModel(leverage());
    expect(vm.leverage).not.toHaveProperty('national_id');
    expect(vm.leverage).not.toHaveProperty('nationalId');
    expect(vm.leverage).not.toHaveProperty('phone');
  });
});

describe('LeverageCard — READ-ONLY guard (HB-1 mutation is a separate slice)', () => {
  const source = readFileSync(
    join(
      __dirname,
      '..',
      'app',
      '[locale]',
      '(dashboard)',
      'projects',
      '[id]',
      '_components',
      'leverage-card.tsx',
    ),
    'utf8',
  );

  it('11) the card issues NO state-changing call (no mutation primitives)', () => {
    // The card is a pure READ surface this slice: it must not import or invoke
    // any mutation primitive. The one-tap follow-up action is the HB-1 slice.
    expect(source).not.toMatch(/\bpostIdempotent\b/);
    expect(source).not.toMatch(/\.(post|patch|put|delete)\b/);
    expect(source).not.toMatch(/\buseMutation\b/);
    expect(source).not.toMatch(/\bmutateAsync\b/);
    // No HB-1 reminder-mutation i18n key wired in (the card uses none).
    expect(source).not.toMatch(/leverage\.remind/);
  });

  it('12) the card navigates read-safely (a Link to the apartment, no <form>)', () => {
    expect(source).toMatch(/href=\{`\/apartments\//);
    expect(source).not.toMatch(/<form/);
  });
});
