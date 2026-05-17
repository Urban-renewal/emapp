# @emapp/web — Next.js 15 Frontend

App Router, RTL (Hebrew default), Heebo font, shadcn/ui, next-intl.

## Critical rules
- Never import from `@emapp/config` (serverEnv) in client components — server-side only.
- All user-facing strings go through next-intl (`useTranslations` / `getTranslations`).
- RTL-first: use `ms-*` / `me-*` (margin-start/end) not `ml-*` / `mr-*`.
- shadcn components live in `src/components/ui/`. Add via `npx shadcn@latest add <component>`.
- No `console.log` in production code.

## Starting the server
```
pnpm --filter @emapp/web dev   # runs on port 3001
```

## Adding a locale string
1. Add to `src/messages/he.json` (Hebrew first — default locale).
2. Add matching key to `src/messages/en.json`.
3. Use in component: `const t = useTranslations('namespace')`.

## Architecture
- `src/app/layout.tsx` — minimal root (Next.js requirement)
- `src/app/[locale]/layout.tsx` — Heebo + RTL + NextIntlClientProvider
- `src/middleware.ts` — next-intl locale routing
- `src/i18n/routing.ts` — locale config (he | en)
- `src/components/ui/` — shadcn components
- `src/lib/utils.ts` — cn() utility
