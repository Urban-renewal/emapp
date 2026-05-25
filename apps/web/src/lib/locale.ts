'use client';

import { useLocale } from 'next-intl';

/**
 * §SOLID-M6 closure — single source of truth for narrowing next-intl's
 * `useLocale()` (which returns `string`) to our supported set
 * (`'he' | 'en'`).
 *
 * Was previously duplicated as `function he_or_en(loc: string)` in 7
 * hook files (use-projects, use-owners, use-buildings, use-apartments,
 * use-documents, use-imports, use-signature-requests). Phase 4b will
 * need it too; centralising it now lets the next entity add one
 * import instead of one copy of the function.
 */
export type DisplayLocale = 'he' | 'en';

export function narrowLocale(loc: string): DisplayLocale {
  return loc === 'en' ? 'en' : 'he';
}

export function useDisplayLocale(): DisplayLocale {
  return narrowLocale(useLocale());
}
