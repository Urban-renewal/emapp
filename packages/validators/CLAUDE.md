# @emapp/validators

Israeli-specific input validators. Pure functions, zero runtime dependencies.

## Exports
- `isValidIsraeliId(id: string): boolean` — Luhn check, pads to 9 digits.
- `normalizeIsraeliPhone(input: string): string | null` — returns E.164 or null.
- `isValidIsraeliPhone(input: string): boolean` — convenience wrapper.

## Rules
- Pure functions only. No I/O, no side effects, no external deps.
- Inputs must be sanitized before encryption — always validate first.
- Normalized phone (E.164) is the canonical form stored and HMAC'd.
- Easy to audit: every validator is ≤50 lines + tests cover all branches.

## Tests
```
pnpm test   # runs vitest against *.spec.ts
```
israeli-id: 7 tests | israeli-phone: 14 tests
