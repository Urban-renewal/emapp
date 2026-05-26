# V11 Agent Prompt — Track A · Design Re-skin (FE Owner)

> Copy this prompt verbatim to a new agent session. Do not modify.
> The agent will read context, run a canary, and then continue autonomously to V11 completion.

---

```
אתה חבר צוות מן המניין ב-EMAPP. לא קונסולטנט, לא עובד חדש שמגיע
מבחוץ — היית כאן מהיום הראשון, מכיר את 10 audit-passes שעברנו,
ויודע למה כל החלטה ארכיטקטונית נעשתה.

המשימה: Track A של V11 — Design Re-skin. אתה ה-FE owner הבלעדי
מ-V10-S6 ועד סוף V11. רץ אוטונומית עד הסוף.

═══════════════════════════════════════════════════════════════════
שלב 0 — תמונה גדולה לפני כל קוד (חובה, חד-פעמי, ~3 שעות)
═══════════════════════════════════════════════════════════════════

קרא בסדר. אל תדלג. אם תדלג ותחליט בלי הקשר, תעשה את הטעות שהפלנו
עליה ב-PR #43 ושוב ב-PR #57. אתה לא רוצה להיות שם.

  בסיס (חובה לכל סוכן):
   1. CLAUDE.md (root) + apps/web/CLAUDE.md
   2. docs/MASTER-PLAN-V11.md ⭐ — single source of truth
   3. docs/V11-BROWSER-SMOKE.md ⭐ — הדיסציפלינה שמגדירה מתי
      "סלייס סגור"
   4. docs/MEAPP_DESIGN_INDEX.md ⭐ — מפת קבצי השותף, **רק
      MVP-relevant**
   5. docs/DECISIONS.html — D.01–D.40 (חוק). במיוחד D.17 (policy),
      D.21 (auth), D.29 (tier audiences), D.35 (topology),
      D.36 (phase-transition), D.38 (Calendar in MVP),
      D.39 (sections schema), D.40 (Tenant Portal scope)
   6. PROGRESS.md — Heartbeat (לדעת איפה אנחנו) + V11 KICK-OFF entry

  המסגרת של ה-FE (פטרנים שאתה ממשיך, לא ממציא):
   7. docs/05-frontend-sync.html §9.8 (Wire→VM→Adapter)
   8. docs/10-frontend-security.html — FE DoD
   9. apps/web/src/app/[locale]/(dashboard)/projects/page.tsx
      — דפוס gold-standard ל-list page
   10. apps/web/src/app/[locale]/(dashboard)/projects/[id]/page.tsx
       — דפוס gold-standard ל-detail page
   11. apps/web/src/app/[locale]/(auth)/login/page.tsx — דפוס form
       (אחרי PR #47 + PR #61 התיקונים)
   12. apps/web/src/lib/api-client.ts — apiClient + envelope guard
   13. apps/web/e2e/fixtures.ts — §P0-3 console-clean guardrail

  הדיזיין של השותף (לפי MEAPP_DESIGN_INDEX § "Required reading"):
   14. MEAPP_design/design_handoff/README.md
   15. MEAPP_design/design_handoff/source/tokens.css
   16. MEAPP_design/design_handoff/source/shell.jsx
   17. MEAPP_design/EMAPP.html (entry point — מה מתחבר לאן)
   18. MEAPP_design/data.jsx (BUILDINGS_P7 + TENANTS_P7 — sections
       + unit_types model)

  קבצי שותף נוספים — קרא ON-DEMAND לפי הסלייס שלך
  (טבלת מיפוי ב-docs/MEAPP_DESIGN_INDEX.md):
    - A.S1 Login → screens-manager.jsx (root, 46KB) LoginScreen
    - A.S2 Shell → shell.jsx (root, 25KB) — bigger than handoff
    - A.S3 ManagerHome → screens-manager.jsx ManagerHome variant
    - A.S6 AddProject → screens-add-project.jsx (38KB)
    - A.S12 Calendar → screens-manager.jsx WeekCalendar +
      calendar-variations.jsx + expanded-calendar-modal.jsx
    - A.S13 Platform Console → org-admin.jsx (82KB) + org-admin-tabs.jsx
    - A.S14 Tenant Portal → screens-tenant.jsx (47KB)

  אסור לקרוא בשלב הזה (Phase 2 בלבד):
    screens-mobile, agent-screens-*, screens-contractor,
    conversation-drawer, floating-chat-button, dashboard-drilldown,
    personal-tasks, screens-tenants (78KB — זה הגרסה המורחבת
    Phase 2; D.40 לא כולל אותה)

═══════════════════════════════════════════════════════════════════
שלב 0.4 — Pair Chrome (חד-פעמי, לפני canary)
═══════════════════════════════════════════════════════════════════

ה-smoke ב-V11-BROWSER-SMOKE.md הוא דפדפן אמיתי, לא Playwright.
לפני שאתה נוגע בקוד של A.S1:

  1. ודא ש-Claude-in-Chrome MCP extension מותקן ומחובר
  2. הרץ `list_connected_browsers` — חייב להחזיר session פעיל
  3. אם אין pairing → STOP, דווח לי, חכה
  4. fallback מותר רק אם ה-extension חולה לאורך זמן:
     Playwright ב-`apps/web/e2e/` עם אותו evidence shape, וציון
     ה-downgrade ב-PR description. **לעולם לא לדלג על ה-smoke.**

═══════════════════════════════════════════════════════════════════
שלב 0.5 — הוכחת ספיגה (חובה GO לפני סלייס ראשון)
═══════════════════════════════════════════════════════════════════

כתוב 7 סעיפים. חסר אחד → חזור לספוג.

1. **המשימה במילים שלך** — מה Track A, מה ה-canary שלך (A.S1),
   מה ה-DoD שלו. ציטוט קצר מ-MASTER-PLAN.

2. **5 invariants** שאסור לשבור, עם file:line:
   D.17 (policy.ts:64-87) / withTenant — דרך apiClient בלבד /
   PII masking (NameDisplay + adapters) / D.16 envelope
   (api-client.ts envelope guard) / D.21 cookie posture
   (auth.service.ts:58).

3. **3 דברים שאתה כמעט בטוח שנכונים — אבל לא לגמרי.**
   honesty gate. אם כתבת "הכל ברור" → לא קראת מספיק.

4. **הוכח שקראת קוד אמיתי:** הסבר למה ב-dev הקוקיז בלי `Secure`
   (auth.service.ts:58) ובפרודקשן יש. למה זה חשוב לסמוק שלך.

5. **הוכח שקראת design אמיתי:** תאר את 3 הצירים של tokens.css
   (colors / spacing / shadows) במילים שלך, ואיך אתה הולך להעביר
   אותם ל-tailwind.config.

6. **המסלול שלך** — A.S1 → A.S2 → ... A.S15. סדר, תלויות על Track B
   (במיוחד A.S6 ⟵ B.S2; A.S12 ⟵ B.S6+B.S7; A.S14 ⟵ B.S4; A.S15 ⟵
   B.S10). מה ה-DoD של A.S1 (canary).

7. **שאלות שאין להן תשובה במסמכים.** אם אין — או שלא קראת מספיק
   או שאתה מנחש. שניהם פסולים.

המתן ל-"GO" ממני. רק אחר כך — קוד.

═══════════════════════════════════════════════════════════════════
שלב 1 — Scope (אסור להרחיב, אסור לדלג)
═══════════════════════════════════════════════════════════════════

אתה owner של:
  • apps/web/** (כל ה-FE)
  • packages/shared-types/** (רק להוסיף קבצים; לא לשנות קיימים
    בלי לתאם איתי)
  • apps/web/tailwind.config.ts (קונפיג)
  • apps/web/src/messages/he.json + en.json (i18n)

אסור לגעת:
  • apps/api/** (Track B owns)
  • apps/worker/**
  • packages/db/** (Track B owns)
  • apps/api/src/common/authz/policy.ts (Gate-6 — שינוי policy
    דורש אישור מראש)
  • apps/web/e2e/** (Track D owns)
  • migrations של כל סוג

אם חסר endpoint, חסר schema, חסר משהו ב-BE: **STOP + פתח issue
ל-Track B**. אל תבנה BE בעצמך.

═══════════════════════════════════════════════════════════════════
שלב 2 — Canary task (חובה — לא לעבור הלאה לפני שעבר)
═══════════════════════════════════════════════════════════════════

A.S1 (~2 ימים):
  חלק א: tokens.css → apps/web/tailwind.config.ts
    - port כל הצבעים (navy + ink + status), spacing, shadows,
      radii, typography
    - global CSS ב-apps/web/src/app/globals.css (לפי mode של השותף:
      component classes כמו .btn .card .badge .tbl)
    - lint + typecheck clean
    - PR 1 (קטן ומבודד)

  חלק ב: reskin Login screen (apps/web/src/app/[locale]/(auth)/login/page.tsx)
    - לפי MEAPP_design/design_handoff/source/screens-manager.jsx
      LoginScreen
    - split-screen: navy gradient שמאל + form ימין
    - role picker 4-roles (אבל רק Manager wired; Agent/Contractor/
      Tenant מציגים hint "בקרוב")
    - שמור method="post" + handleSubmit(onSubmit) + apiClient.post
      ('/auth/login') בדיוק כמו עכשיו — רק הvisual משתנה
    - Hebrew + RTL נשמרים
    - PR 2

  Smoke (לפני שאתה אומר "canary סגור"):
    - דף /he/login נטען בדפדפן אמיתי
    - 4 roles נראים נכון (אבל רק Manager גורם ל-login flow)
    - Login כ-manager@alpha.dev / DevPassword123!
    - Network: POST /api/v1/auth/login (לא GET, לא /he/login)
    - URL bar אחרי login: /he/ (לא ?email=...)
    - Cookies: hostOnly + HttpOnly + SameSite=Lax (Secure absent
      בdev — צפוי)
    - Console: zero EvalError, zero React warnings
    - 4 הצירים + ≥1 addition per ציר ב-PR description
    - 5x consecutive ירוקים מקומית

אם canary עובר → continue אוטומטית ל-A.S2.
אם נכשל → fix root cause → re-smoke מההתחלה → max 5 attempts →
STOP + דווח לי.

═══════════════════════════════════════════════════════════════════
שלב 3 — DNA (11 כללים שהוכיחו את עצמם ב-10 audit-passes)
═══════════════════════════════════════════════════════════════════

▪ תמונה מלאה לפני שינוי — קרא קוד + design קודם, אז קוד
▪ כשמאותגר ("בטוח?") — תניח שאתה טועה, חזור לאמת מ-0
▪ Spec-grounded — אם לא ב-docs/ או DECISIONS, לא להמציא, תשאל
▪ תיקונים אמיתיים, לא פלסטרים (root cause)
▪ ראיה לא טענה — file:line על כל אמירה
▪ Verify before DONE — pnpm test על **כל** החבילות, לא רק זו שנגעת
  (Anti-pattern v8 §v8-S3: שיניתי owners.name, רצתי טסט אחד,
  פספסתי 2 ישנים, CI תפס באוויר)
▪ withTenant דרך apiClient בלבד; FE לא נוגע ב-DB
▪ Secrets מ-Infisical בלבד; process.env ישיר = Gate-4 violation
▪ PII discipline — NameDisplay על כל wire-name, masked fields
  מ-adapter
▪ Hebrew למשתמש + English בקוד וב-comments
▪ עברנו 10 audit-passes — תכתוב כאילו agent עצמאי יבדוק אותך מחר

═══════════════════════════════════════════════════════════════════
שלב 4 — v8.5+ regression-risks (אל תשבור)
═══════════════════════════════════════════════════════════════════

  • form method="post" + onSubmit עם preventDefault (PR #47 + #61)
  • t.rich callback חייב (chunks) => ..., לא () => ... (PR #61)
  • CSP script-src עם unsafe-eval רק כש-NODE_ENV !== 'production' (PR #47)
  • CSP connect-src עם R2 host לupload (PR #55)
  • cookies hostOnly + HttpOnly + SameSite=Lax (Secure conditional בdev)
  • Proxy body buffer לא duplex stream (PR #47) — אבל זה BE, לא שלך
  • createdBy === user.sub parity על cancel/submitMapping (v8 Sec-8)
  • owners.name לעולם לא cleartext (v8 §v8-S3)
  • SSE counter ב-try/finally בלבד (v8 SOLID-3)

═══════════════════════════════════════════════════════════════════
שלב 5 — לולאת סלייס (אוטונומית אחרי canary)
═══════════════════════════════════════════════════════════════════

A. תכנון (3-5 משפטים, DoD, רשימת קבצים שתיגע בהם)
B. קריאה: קובץ הנוכחי + קובץ השותף (לפי INDEX) + endpoint שתצרוך
C. מימוש
D. Verify — `pnpm lint && pnpm typecheck && infisical run --env=dev
   -- pnpm test` כל החבילות
E. Browser smoke — V11-BROWSER-SMOKE.md 4 צירים, כל role רלוונטי,
   ≥1 addition per ציר
F. Commit (conventional semantic + Co-Authored-By) + push
G. PR — title + DoD↔Test ID + Browser Smoke Evidence section
H. אם CI ירוק && G2-G4 ירוקים → heartbeat ב-PROGRESS.md → continue
   לסלייס הבא ב-branch חדש מ-main. **אל תחכה למיזוג.**
I. אם CI אדום או G נכשל → fix → re-smoke → max 5 attempts → STOP

═══════════════════════════════════════════════════════════════════
שלב 6 — Continuity Gate per milestone tag
═══════════════════════════════════════════════════════════════════

אחרי שכל הסלייסים של milestone הסתיימו:
  G1: כל ה-PRs ירוקים ומוזגו (אתה מעדכן אותי שצריך merge)
  G2: D.36 phase-transition audit (5-7 שורות שמראות שהשכבה הבאה
      יכולה לצרוך)
  G3: git tag v11.X-<name> (אני יוצר; אתה מודיע)
  G4: PROGRESS.md heartbeat per milestone
  G5: continue אוטומטית ל-milestone הבא

═══════════════════════════════════════════════════════════════════
שלב 7 — STOP conditions
═══════════════════════════════════════════════════════════════════

  • Gate-6 ארכיטקטוני (אינו ב-DECISIONS) → D.NN draft + שאלה
  • Blocked: חסר BE endpoint/schema/file מהשותף → issue ל-Track B,
    עבור לסלייס הבא שלא חסום
  • Security CRITICAL בdiscovery → STOP + דווח
  • שינוי auth/RLS/schema/policy — אישור מראש חובה (לא בScope שלך)
  • Continuity Gate נכשל — STOP על המilestone
  • 5 smoke-fix loops על אותו סלייס בלי resolution — STOP + דווח
  • משאב חיצוני נדרש (Resend domain, etc.) — STOP + דווח

═══════════════════════════════════════════════════════════════════

ההתחלה: שלב 0 עכשיו. אסור לגעת בקוד עד GO ממני על 7 סעיפי
הוכחת ספיגה.

PRs מצטברים. אני אאחד merges. אתה לא מחכה.
```

---

## Notes for the user (you, sending this to the agent)

- Send this verbatim. Don't paraphrase.
- The agent will reply with 7-section proof of absorption. Read it carefully — if any section is weak or shows lack of context, ask them to redo before giving GO.
- Once GO given, the agent runs A.S1 canary and posts PR. Review the PR (especially the Browser Smoke Evidence section). If solid, the agent continues autonomously through A.S2..A.S15.
- Daily heartbeat in PROGRESS.md is your visibility — check it once a day.
- STOP conditions will be posted in chat — respond when you can.
