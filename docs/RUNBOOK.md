# RUNBOOK — תפעול EMAPP (Phase 9)

> נכון ל-2026-06-12. כל דבר לא-מאומת או חסר מסומן ⚠️ במפורש.
> Onboarding למפתח חדש: `ONBOARDING.md` + `docs/LOCAL-DEV.md` — לא משוכפלים כאן.

## 1. טופולוגיה

```
Browser ──► Cloudflare Pages (apps/web, app.emapp.io / *.emapp.pages.dev)
                │  same-origin proxy: apps/web/src/app/api/[...path]/route.ts
                ▼
            Railway: @emapp/api (NestJS+Fastify, :3000, trustProxy:1)
            Railway: @emapp/worker (pg-boss consumer + crons, tsx src/main.ts)
                │
                ▼
            Neon PostgreSQL 16 (us-east-1) — RLS + pgcrypto, pgboss schema
            Cloudflare R2 — presigned PUT/GET, EMAPPENC envelope לרגישים
            Resend (IEmailProvider) · SMS: ISMSProvider (prod=019/Inforu, dev=Noop)
            Sentry (SENTRY_DSN_API) · Infisical = מקור הסודות היחיד
```

⚠️ Railway/Pages מוטמעים בקוד ובדוקס (CORS, trustProxy, גרייספול-SIGTERM) אבל **לא נמצאו קבצי deploy ברפו** — ראו §4.

## 2. הרצת dev מקומית

- חד-פעמי: `pnpm install`. worktree חדש: גם `cp .infisical.json` (וגם `pnpm install` בו).
- **כלל ברזל: כל פקודה דרך `infisical run --env=dev -- <cmd>`. אסור `.env` עם ערכים אמיתיים.**
- כל הסטאק (מול Neon המרוחק, ~180ms RTT): `infisical run --env=dev -- pnpm dev` — api על **:3000**, web על **:3001**, worker.
- מסלול מהיר (PG מקומי, ~1ms): `powershell -ExecutionPolicy Bypass -File .\start-dev-local.ps1` — סקריפט gitignored (סיסמת DB מקומית); השחזור המלא + טבלת הלוגינים + `DEV_AUTH_BYPASS=1` (קוד `000000` ל-OTP/MFA, double-gated, dev בלבד) ב-`docs/LOCAL-DEV.md`. חובה דפוס ה-`-Inner`: Infisical דורס env שהוגדר לפניו.
- **gotcha :3000 תפוס (stale server):** תהליך node ישן מחזיק את הפורט — `/health` ירוק _מהשרת הישן_ בזמן שהקוד החדש בכלל לא רץ. אחרי החלפת branch לוודא שאין `EADDRINUSE` בלוג. Windows: `Get-NetTCPConnection -LocalPort 3000` → `Stop-Process`, או `Get-Process node | Stop-Process -Force` (pkill לא תופס node ב-Windows).
- דגלי dev ל-QA: `EXPOSE_INVITE_TOKEN` / `EXPOSE_STEP_UP_CODE` (`'true'`, חסומים ב-production) — מחזירים את הטוקן/קוד בתשובת ה-API.
- **ערכת PG מקומית opt-in** (`docker-compose.dev.yml` + `infra/local-db/`): ⚠️ קיימת **רק ב-PR #363 (draft)**, לא ב-main; חסומה על התקנת Docker Desktop (owner action). ב-main יש `docker-compose.yml` ותיק (postgres/redis/minio/mailhog) — לא במסלול העבודה הנוכחי.

## 3. מיגרציות

- **לעולם לא `drizzle-kit generate`** (דורש TTY + מייצר snapshots חסרים). כותבים `.sql` ידנית תחת `packages/db/drizzle/` + רשומה ידנית ב-`_journal.json`.
- **כלל M-1:** המיגרטור של drizzle מדלג **בשקט** על מיגרציה שה-`when` שלה קטן מהמקסימום שכבר הוחל. `when` של מיגרציה חדשה חייב להיות גדול מכל הקיימים. dev 0056 תוקן ידנית (2026-06-10). ⚠️ **חסר CI guard pre-prod** — פתוח.
- הרצה: `infisical run --env=dev -- pnpm --filter @emapp/db db:migrate` (`packages/db/scripts/migrate.ts`). נכשל-מהר אם `PII_ENCRYPTION_KEY`/`PII_HASH_KEY` חסרים (ה-GUCs משרתים backfill מוצפן בתוך מיגרציות).
- `DATABASE_URL` למיגרציות חייב להיות **session-pooled** (host של Neon בלי `-pooler`) — GUCs לא שורדים transaction pooler.
- rollbacks ידניים קיימים רק ל-0035/0036 (`packages/db/scripts/rollback-00*.sql`).

## 4. דיפלוי — המצב הכן

- ⚠️ **אין pipeline דיפלוי ברפו.** אין `railway.json`/`Dockerfile`/wrangler config, ואין job של deploy ב-`.github/workflows/ci.yml`. ה-CI הוא quality-gates בלבד: typecheck · lint · test (PG16 service + Playwright chromium) · build · conformance (בוט API מקומפל + contract specs עם `THROTTLE_TEST_BYPASS`) · e2e (MSW) · trufflehog · `pnpm audit --audit-level=high`.
- מה נדרש כדי לעלות staging/prod (לא בוצע): שירותי Railway (api: `nest build` → `node dist/main`; worker: `tsx src/main.ts` — אין build), Cloudflare Pages ל-web, Infisical envs + מפתחות (§5), `db:migrate` לפני boot ראשון, `bootstrap-provider-admin` (ONBOARDING §4.1a), חיבור דומיין `app.emapp.io` (ה-CORS/CSP כבר מניחים אותו).
- רוטציית סודות בלי restart: `SIGHUP` ל-api מרענן env ומפיל את ה-storage singleton (`apps/api/src/main.ts`).

## 5. סודות (Infisical)

- envs: **dev קיים ופעיל.** ⚠️ **staging/prod — טרם הוקמו מפתחות** (owner action):
  - `PII_ENCRYPTION_KEY` + `PII_HASH_KEY` — 44-char base64 (`openssl rand -base64 32`), מפתחות **נפרדים** פר-env. ה-API מסרב לעלות בלעדיהם (`verifyEncryptionStartup`).
  - `DOC_ENCRYPTION_KEY` — 44-char base64, מעטפת `EMAPPENC` למסמכים רגישים. **אובדן המפתח = כל המסמכים המוצפנים אבודים לצמיתות** — לגבות את הערך בכספת נפרדת מ-Infisical, לא רק שם.
- עוד בענן הסודות: `JWT_SECRET`, `SIGNATURE_TOKEN_SECRET` (ה-API נופל ב-boot בלעדיו), R2 creds (⚠️ ה-dev creds נחשבים compromised מאז v7 — רוטציה פתוחה), Resend, `SENTRY_DSN_API`, `PROVIDER_DATABASE_URL` (חובה ב-production, role עם BYPASSRLS — `verifyProviderPoolRole`).

## 6. ניטור

- **Sentry** — מאומת ב-`apps/api/src/instrument.ts`: init רק כש-`SENTRY_DSN_API` קיים (init בלי DSN = CPU spin, QA-OTP-1), `tracesSampleRate: 0.1`, breadcrumbs על pool errors. web: `@sentry/nextjs` מותקן ⚠️ DSN ל-FE לא אומת כמוגדר.
- endpoints (`apps/api/src/app.controller.ts`, `modules/observability/`): `/api/v1/health` = liveness בלי DB (לא להחליף — DB-ping ב-liveness הופך תקלת DB ל-restart מדורג); `/api/v1/ready` = readiness עם DB ping; `/api/v1/metrics` = Prometheus scrape (ב-dev/test — Noop, גוף ריק; הגנת גישה ברמת ingress, לא app-auth).
- ⚠️ **מה שעוד אין:** Sentry alert rules (owner — קונסולת Sentry), uptime monitor חיצוני, Prometheus scraper מחובר, alerting כלשהו על worker failures.

## 7. תקלות נפוצות

| סימפטום                                                                      | אבחנה / פעולה                                                                                                                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API "רץ" אבל הקוד ישן / login נכשל                                           | stale :3000 — §2. לבדוק `EADDRINUSE` בלוג אחרי כל החלפת branch                                                                                                        |
| `documents.contract` / live-server contract specs נכשלים מקומית ב-`http_429` | דפוס מתועד: throttle אמיתי מול api dev מקומי. SKIP נקי בלי שרת; ירוקים ב-CI עם `THROTTLE_TEST_BYPASS`. **לא לדבג**                                                    |
| `provider-audit.spec` (T6.5-D37-7a) נופל ב-full-suite                        | זיהום מקבילי ידוע (cursor walk). rerun, לא debug, אם ה-diff לא נוגע ב-provider audit                                                                                  |
| `imports.s8.spec` A7/C10/C11 נופלים ב-full-suite                             | R2-purge deadlines תחת עומס מקבילי. ירוק באיזולציה — rerun                                                                                                            |
| `apps/worker/test/l6-cache.spec.ts` נופל ב-full-suite                        | ⚠️ מדווח כ-flaky (לא תועד בכתב בלדג'ר) — להריץ באיזולציה לפני debug                                                                                                   |
| PR לא נכנס ב-merge-on-green                                                  | `BEHIND` → update branch מ-main + להמתין ל-CI מחדש; `DIRTY` כמעט תמיד על `docs/V12-SLICE-LEDGER.md` → לפתור append-both. לקח #367: עריכות ledger רק על ה-branch הפעיל |
| worktree חדש "שבור"                                                          | `pnpm install` + `cp .infisical.json` לתוך ה-worktree                                                                                                                 |
| login 401 עם סיסמה נכונה (provider)                                          | ה-API מחובר ל-Neon המרוחק במקום ל-PG המקומי — להפעיל מחדש דרך `start-dev-local.ps1`                                                                                   |

## 8. משימות ops ממתינות (owner-gated)

1. **mapi bulk load (669MB):** להוריד את ה-ZIP החודשי של מפ"י → לנרמל ל-CSV עם header `block,parcel,sub,city,lat,lng` → `infisical run --env=dev -- pnpm --filter @emapp/db exec tsx scripts/load-parcel-lookup.ts <path/to/parcels.csv>`. Upsert אידמפוטנטי (ריענון חודשי = להריץ שוב); רץ על providerPool (ה-app SELECT-only על `parcel_lookup`). ⚠️ שלב הנרמול ZIP→CSV לא ממוסמך בסקריפט — לתעד בריצה הראשונה.
2. **GovMap (P3d):** רישום טוקן פר-דומיין (במייל) + אימות ToS ושימוש server-side — ה-wire shape לא מאומת (הדוקס הרשמיים הם JS-SDK לדפדפן). ראו `docs/DESIGN-phase3-parcel-autosetup.md`.
3. **Docker Desktop** על מכונת ה-dev → unblock perf kit **PR #363** (draft; אין ראיות perf עד אז).
4. **מפתחות staging/prod** (§5): `PII_ENCRYPTION_KEY`/`PII_HASH_KEY`/`DOC_ENCRYPTION_KEY` + גיבוי כספת.
5. **רוטציית R2 dev creds** (ONBOARDING §4.1 — נחשפו בצ'אט ב-v7).
6. **CI guard ל-M-1** (מיגרציה מדולגת בשקט) — pre-prod, טרם נבנה.
