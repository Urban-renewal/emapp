/**
 * 7c F3 — pure-seam pins for the tabu review section.
 *
 * 1. `isMaskedNationalId` — THE security seam from the 7c review finding: a
 *    masked actor (D.19/D.47 fidelity) receives '•••••••NN'; the ת.ז. field
 *    must be READ-ONLY so the bullets can never round-trip into the PATCH
 *    body (which would re-encrypt the mask over the real value).
 * 2. `sumShares` — the confirm-summary fraction math ("סך חלקים מלא").
 */
import { describe, expect, it } from 'vitest';

import { isMaskedNationalId, sumShares } from './tabu-review-section';

describe('isMaskedNationalId (7c masked-PII PATCH guard)', () => {
  it('detects the D.19/D.47 bullet mask', () => {
    expect(isMaskedNationalId('•••••••82')).toBe(true);
    expect(isMaskedNationalId('12345678•')).toBe(true);
  });

  it('a clear national id (full fidelity) is NOT masked', () => {
    expect(isMaskedNationalId('123456782')).toBe(false);
  });

  it('null (no parsed id) is NOT masked — stays editable', () => {
    expect(isMaskedNationalId(null)).toBe(false);
  });
});

describe('sumShares (confirm summary fraction)', () => {
  it('1/2 + 1/2 = full (1/1)', () => {
    expect(
      sumShares([
        { shareNumerator: 1, shareDenominator: 2 },
        { shareNumerator: 1, shareDenominator: 2 },
      ]),
    ).toEqual({ num: 1, den: 1 });
  });

  it('1/3 + 1/3 reduces to 2/3 (partial)', () => {
    expect(
      sumShares([
        { shareNumerator: 1, shareDenominator: 3 },
        { shareNumerator: 1, shareDenominator: 3 },
      ]),
    ).toEqual({ num: 2, den: 3 });
  });

  it('1/2 + 1/4 + 1/4 = full across mixed denominators', () => {
    expect(
      sumShares([
        { shareNumerator: 1, shareDenominator: 2 },
        { shareNumerator: 1, shareDenominator: 4 },
        { shareNumerator: 1, shareDenominator: 4 },
      ]),
    ).toEqual({ num: 1, den: 1 });
  });

  it('returns null when any row is missing its fraction (unknown total)', () => {
    expect(
      sumShares([
        { shareNumerator: 1, shareDenominator: 2 },
        { shareNumerator: null, shareDenominator: 2 },
      ]),
    ).toBeNull();
    expect(sumShares([{ shareNumerator: 1, shareDenominator: 0 }])).toBeNull();
  });
});
