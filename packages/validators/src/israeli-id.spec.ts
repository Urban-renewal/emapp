import { describe, it, expect } from 'vitest';
import { isValidIsraeliId } from './israeli-id';

describe('isValidIsraeliId', () => {
  it('accepts valid 9-digit Israeli ID', () => {
    expect(isValidIsraeliId('123456782')).toBe(true);
  });

  it('accepts valid ID with padding (8 digits)', () => {
    // '12345674' padded to '012345674'
    expect(isValidIsraeliId('12345674')).toBe(true);
  });

  it('rejects ID with invalid checksum', () => {
    expect(isValidIsraeliId('123456789')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidIsraeliId('')).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(isValidIsraeliId('12345678a')).toBe(false);
  });

  it('rejects more than 9 digits', () => {
    expect(isValidIsraeliId('1234567890')).toBe(false);
  });

  it('rejects non-string input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isValidIsraeliId(123456782 as any)).toBe(false);
  });
});
