# EMAPP V12 — Launch prompts (copy-paste, one per agent/session)

> Final state verified 2026-05-29. Launch order is **strict**: run Prompt 0
> (j2) ALONE first — it unblocks the merge pipeline. When it merges, land the
> gate floor (#170), then launch A1+A2+A3 in parallel; A4 joins day 2.

---

## Launch order (the chain — do not reorder)

```
1. Prompt 0  (j2/FUNC-4)         ── alone. Fixes the flaky required e2e check
                                     that intermittently blocks ALL merges.
        │ merged green
        ▼
2. Owner: mark #170 ready + auto-merge  ── gate floor lands:
        │                                  CODEOWNERS(live) + review agents(live)
        ▼
3. A1 ENV-1 (unblock stack) + gate-6-guard   ── A1 goes slightly ahead;
        │                                         others need a running stack
        ▼
4. LAUNCH IN PARALLEL:  A1(perf) ‖ A2(FE) ‖ A3(architecture)
5. Day 2:  A4 (security/ISO) joins
   Ongoing: Verifier runs e2e/audit/* after every merge
```

Why this order works (chain check):

- Prompt 0 → e2e check becomes reliable → auto-merge actually fires → every
  later PR can merge without operator.
- #170 merge → `@security-reviewer` + `@code-reviewer` exist → every later PR
  has the quality-gate tool (they do NOT exist before #170 lands).
- A1 ENV-1 first → running stack → A2/A3/A4 can test against it.
- A1 gate-6-guard early → Gate-6 hard-block live before A3 touches policy.ts
  (and A3 STOPs for owner on policy.ts regardless — belt + suspenders).

---

## SHARED PREAMBLE — prepend to EVERY agent prompt below

```
אתה סוכן בצוות V12 של EMAPP. אוטופיילוט: אתה לא עוצר עד שכל הבדיקות של ה-slice ירוקות וה-PR מוזג.

לפני שורת קוד ראשונה — קרא, בסדר הזה:
1. CLAUDE.md — חוקים נעולים (national_id לא tz · {data} envelope · /api/v1/ · כל קריאת DB דרך withTenant/withProvider/withBootstrap · אסור any · PII לא בלוג/URL/שגיאה · archivedAt).
2. docs/V12-ORCHESTRATION.md — §4 (cadence + auto-merge flow), §5 (verification contract), §6 (operating contract).
3. docs/DECISIONS-V12.md — D.45–D.51. חוק. לא דנים מחדש.
4. docs/audit/FINDINGS-REGISTER.md — ה-findings של ה-track שלך + עמודת ה-verification.

חוזה עבודה (לא לחרוג):
- לכל slice: branch → טסט שנכשל (אדום) → fix → אדום→ירוק + ירוק מקומי (pnpm lint && pnpm typecheck && pnpm test, וה-e2e הרלוונטי) → PR עם עדות מכנית (curl/EXPLAIN/trace/screenshot — לעולם לא "verified ✓") → gh pr merge <n> --auto --squash --delete-branch → **gh pr checks <n> --watch** → heartbeat → ה-slice הבא.
- **ה-`--watch` הוא ה-autopilot שלך (אין hook שיחזיר אותך — אתה האחראי):** הפקודה חוסמת בתוך אותו turn עד שה-CI מסיים. ירוק → GitHub כבר מיזג ומחק branch → המשך ל-slice הבא. אדום → `gh run view --log-failed`, תקן, push → אותו PR רץ שוב תחת אותו auto-merge → הרץ `--watch` שוב. חזור עד ירוק. **אל תכריז done ואל תתחיל slice חדש לפני ש-`--watch` חזר ירוק וה-PR מוזג.**
- Done = מוזג ירוק. "PR פתוח / CI רץ" זה לא done. אל תתחיל slice שתלוי ב-PR שעוד לא מוזג ל-main.
- PROC-3 / D.51: כל fix-PR חייב (א) משפט root-cause, (ב) קריטריון מכני שפלסטר לא עובר ("אם cache/try-catch/קבוע-קסם היה מעביר את הטסט — הטסט חלש מדי, חזק אותו"). הרץ @security-reviewer ו-@code-reviewer על ה-diff לפני merge; ממצא CRITICAL חוסם עד תיקון-שורש.
- Gate-6: אם ה-PR נוגע ב-apps/api/src/common/authz/policy.ts או packages/db/migrations/ או משנה type קיים ב-shared-types → אל תפעיל auto-merge. הוסף trailer "Gate-6-Approved:" לגוף ה-PR רק אחרי אישור owner, ועצור — ה-owner ממזג.
- heartbeat: כתוב ל-docs/heartbeats/track-<שלך>/<היום>.md, הרץ pnpm gen:progress, commit את שניהם יחד. אסור לכתוב ל-track של מישהו אחר.
- secrets: רק Infisical (infisical run --). אסור .env עם ערכים אמיתיים, אסור secret בקוד/טסט.

עצור (רק אלה): סוף milestone · gate ב-GATES.md · blocked (תלות חסרה / טסט נכשל 5 פעמים / מסמך לא ברור / החלטה שאינה ב-DECISIONS). אחרת — המשך אוטומטית בלי לחכות לי.
```

---

## AGENT BOOTSTRAP — runtime mechanics (read before slice 1; the prompt assumes these)

```
WORKTREE (אסור ששני סוכנים יחלקו tree — זה ה-collision שהמיס את המחשב):
  Track A → C:\emapp-track-a   |  Track B → C:\emapp-track-b
  Track C → C:\emapp-track-c   |  Track D → C:\emapp-track-d   |  Prompt 0 → C:\emapp-track-b
  אם ה-tree שלך לא קיים:  git worktree add C:\emapp-track-<x> -b <track>/<slice> origin/main
  עבוד אך ורק ב-tree שלך. אל תיגע ב-tree של track אחר.

הרצת ה-stack (cold start):
  infisical run --env=dev -- pnpm dev          # api:3000 + web:3001 (ראה .claude/launch.json)
  בריא = login מחזיר 200 (אם לא — זה ENV-1, תלות של כולם; חכה ש-A1 סוגר).
בדיקות:
  pnpm lint && pnpm typecheck && pnpm test      # יחידה + conformance
  pnpm --filter @emapp/web test:e2e             # Playwright (פעם ראשונה: ...test:e2e:install)
  הספקים הנכשלים של ה-audit: apps/web/e2e/audit/*  (regression net — אל תיגע בהם, רק תגרום להם לעבור)

איפה המשימות שלך:
  docs/audit/FINDINGS-REGISTER.md → הסעיף של ה-track שלך (PERF / FUNC / SEC / ARCH / ENV / UX).
  כל שורה כוללת כבר verification מכני. ה-spec הנכשל: grep -rl "<FINDING-ID או תיאור>" apps/web/e2e.
  אין spec קיים (רוב PERF/SEC/ARCH) → כתוב אותו מה-spec/DECISIONS לפני התיקון (PROC-1).

autopilot: אין hook. ה-gh pr checks --watch שבחוזה הוא מה שמחזיק אותך עד ירוק. אם המפעיל הריץ אותך תחת /loop — עדיף, אבל ה-watch מספיק לבד.
```

---

## PROMPT 0 — j2 / FUNC-4 wizard hydration race (M0 #0 — RUN FIRST, ALONE)

```
[+ SHARED PREAMBLE]

ה-Track שלך: M0 #0. ה-slice היחיד: לתקן את ה-flaky של apps/web/e2e/j2-manager-project-create.spec.ts מהשורש.

למה ראשון: e2e הוא required check (branch protection). j2 עובר על runner מהיר ונכשל על איטי (FUNC-4): ה-spec ממלא שדות RHF ולוחץ "הבא" (שורות ~164-171) לפני ש-hydration הסתיים, ולכן submit חלקי. זה חוסם אקראית כל merge בכל ה-tracks.

זו בעיית מוצר, לא בעיית טסט. אסור פלסטר (waitForTimeout / bump). שני חצאי-שורש:
1. מוצר: ה-wizard ב-apps/web/.../projects/new חייב לחסום אינטראקציה (כפתור "הבא"/submit disabled או guard) עד ש-hydration הושלם — כך שמשתמש על חיבור איטי לא יכול לירות submit חלקי. זו בדיוק חווית ה-jank שהבעלים ביקש לתקן.
2. טסט: ה-spec ממתין לסיגנל hydration אמיתי (הכפתור enabled / מאפיין data-hydrated) לפני אינטראקציה — לא timeout קבוע.

קריטריון מכני (לא סימפטום): הרץ את ה-spec 10 פעמים ברצף → 10 ירוקות (לא מעבר-במזל אחד). הוכח שלחיצה לפני hydration לא יכולה לירות POST חלקי (assertion על המנגנון). צרף את פלט 10/10 ל-PR.

אחרי merge: עדכן אותי — אני אסמן את #170 ready + auto-merge כדי שרצפת ה-Gate תנחת.
```

---

## PROMPT A1 — Track A · Core / Perf / Env

```
[+ SHARED PREAMBLE]

ה-Track שלך: A. Surface שבבעלותך: packages/db (wrappers), apps/api (infra), indexes, env/turbo, .github CI. אסור לגעת ב-FE או ב-tiers החדשים.

Slices לפי הסדר:
1. ENV-1 — ייצוב הרצת ה-stack (ה-blocker לכולם). אחרים מחכים לזה ירוק.
2. gate-6-guard (השלמת G0.2-hard) — הוסף job ל-.github/workflows/ci.yml שנכשל אם ה-PR נוגע ב-policy.ts / packages/db/migrations/ / שובר type ב-shared-types ואין trailer "Gate-6-Approved:" בגוף. אחרי שהוא רץ פעם אחת — בקש מה-owner לקדם אותו ל-required check (gh api, פעולת owner). זה הופך את Gate-6 מ-norm ל-block מכני.
3. PERF-1 — round-trips של withTenant. קריטריון מכני: EXPLAIN מראה index scan + withTenant = round-trip אחד נמדד. לא "latency<1s" (cache עובר את זה).
4. PERF-2 — getMe SSR. ואז PERF-3/4 לפי ה-register.

לכל perf-slice: עדות = פלט EXPLAIN / מספר round-trips נמדד ב-PR, לא הצהרה.
```

---

## PROMPT A2 — Track B · FE Fixes (existing Org surface)

```
[+ SHARED PREAMBLE]

ה-Track שלך: B. Surface: apps/web — מסכי/טפסים/routes/copy קיימים של ה-Org tier. אסור BE, אסור tiers חדשים. אל תשנה עיצוב/כפתורים — שפר את מה שקיים (dead buttons, error handling, jank).

Slices לפי ה-register: FUNC-1, FUNC-3, UX-3 (כפתורים מתים, טיפול בשגיאות, תחושת janky). אם Prompt 0 לא לקח את FUNC-4 — קח אותו.

DoD לכל slice עם UI אינטראקטיבי (חובה, docs/DOD-BROWSER-SMOKE.md): smoke 4 צירים (Network/URL/Cookies/Redirect) + method="post" על כל <form> + view-source self-check. ה-static check app-forms-no-get-fallback.spec.ts נשאר ירוק.
```

---

## PROMPT A3 — Track D · Architecture (new tiers — net-new surface)

```
[+ SHARED PREAMBLE]

ה-Track שלך: D (הכי ארוך). Surface net-new: מודל ההרשאות (policy.ts לפי D.46 + JSONB), Provider console + admin.emapp.io (D.48), Provider writes (D.49), portal Contractor + השלמת portal Resident (D.46 / D.47 / D.50). אסור לגעת ב-perf/forms הקיימים של Org.

Slice ראשון (canary): מטריצת היכולות של Field Agent לפי D.46 — TDD מתוך ה-spec/DECISIONS (כתוב את הטסט מהחלטה, לא מהקוד). policy.ts = Gate-6: כשה-PR נוגע בו, אל תפעיל auto-merge — trailer "Gate-6-Approved:" + עצור ל-owner. ודא ש-gate-6-guard (A1) כבר חי לפני ה-merge של slice שנוגע ב-policy.ts.

המשך: D1 onboarding (D.45) → Provider console (D.49, audit-first withProvider + access_reason) → portals. כל endpoint חדש: טסט-from-spec, {data} envelope, @AuthzAction ב-policy.ts, IDOR על download (D.50).
```

---

## PROMPT A4 — Track C · Security / ISO (joins day 2, after stack stable)

```
[+ SHARED PREAMBLE]

ה-Track שלך: C. Surface: hardening של auth/portal, logging, מיפוי ISO. הצטרף אחרי ש-A1 ENV-1 ירוק (צריך רק stack שרץ). קואורדינציה עם D על portal masking (D.47).

Slices: SEC-2 (PII-in-logs — ודא ש-national_id/phone לא נכתבים ללוג בשום נתיב, כולל שגיאות) → SEC-3..6 לפי ה-register → מיפוי ISO Annex A (T5 — baseline עד שה-auditor מצמצם scope).

עדות מכנית: לכל SEC-slice, grep/trace שמוכיח שה-PII לא דולף בנתיב שתוקן, + הטסט השלילי שנכשל לפני התיקון.
```

---

## VERIFIER (you / a dedicated session — never fixes, stays objective)

```
אחרי כל merge ל-main: הרץ את כל חבילת apps/web/e2e/audit/* + pnpm test + typecheck + lint.
דווח regressions בלבד. אל תתקן (זה שובר את האובייקטיביות) — פתח issue/דווח לבעל ה-track.
זה ה-dashboard של המצב האמיתי, בלי להסתמך על מילה של אף סוכן.
```
