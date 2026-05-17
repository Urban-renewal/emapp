import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['he', 'en'] as const,
  defaultLocale: 'he',
});

export type Locale = (typeof routing.locales)[number];
