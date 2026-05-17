const MOBILE_PREFIXES = ['50', '52', '53', '54', '55', '57', '58', '59'];
const LANDLINE_PREFIXES = ['2', '3', '4', '8', '9'];

export function normalizeIsraeliPhone(input: string): string | null {
  if (typeof input !== 'string') return null;

  const cleaned = input.replace(/[\s\-().]/g, '');
  if (cleaned.length === 0) return null;

  let digits: string;

  if (cleaned.startsWith('+972')) {
    digits = cleaned.slice(4);
  } else if (cleaned.startsWith('972')) {
    digits = cleaned.slice(3);
  } else if (cleaned.startsWith('0')) {
    digits = cleaned.slice(1);
  } else {
    return null;
  }

  if (!/^\d+$/.test(digits)) return null;

  // Mobile: 9 digits (2-digit prefix + 7-digit subscriber)
  if (digits.length === 9) {
    const prefix = digits.slice(0, 2);
    if (MOBILE_PREFIXES.includes(prefix)) {
      return `+972${digits}`;
    }
    return null;
  }

  // Landline: 8 digits (1-digit area + 7-digit subscriber)
  if (digits.length === 8) {
    const prefix = digits.slice(0, 1);
    if (LANDLINE_PREFIXES.includes(prefix)) {
      return `+972${digits}`;
    }
    return null;
  }

  return null;
}

export function isValidIsraeliPhone(input: string): boolean {
  return normalizeIsraeliPhone(input) !== null;
}
