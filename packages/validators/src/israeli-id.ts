export function isValidIsraeliId(id: string): boolean {
  if (typeof id !== 'string') return false;
  if (!/^\d{1,9}$/.test(id)) return false;

  const padded = id.padStart(9, '0');

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let digit = parseInt(padded[i]!, 10);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }

  return sum % 10 === 0;
}
