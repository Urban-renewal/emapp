# Agent handoff runbook — the exact flow to install a fresh lead

This is the step-by-step _you_ run to hand the lead role to a fresh agent and verify it before trusting it.
Companion: `docs/LEAD-DOCTRINE.md` (the brain), `docs/AGENT-ACCEPTANCE-TEST.md` (your private answer key).
**Rule of thumb:** you PASTE the prompt + the probe _questions_ to the agent; you keep the _answer keys_ to
yourself (in the acceptance-test doc) and grade against them — never paste the key, or it just parrots it.

---

## PHASE 0 — Before you open the session (2 min, your side)

- [ ] This doc + `LEAD-DOCTRINE.md` + `AGENT-ACCEPTANCE-TEST.md` are merged to `main` (so the fresh agent
      can read them). If not merged yet, merge them first.
- [ ] Local Postgres `:5432` is running.
- [ ] Open `docs/AGENT-ACCEPTANCE-TEST.md` on your screen — that's your grading key for Phase 3.

## PHASE 1 — Ignite (paste BLOCK A: the bootstrap prompt)

Paste BLOCK A (below) into the fresh session. It makes the agent load its "experience" (doctrine + memory +
CLAUDE.md + plans), the live resume point, and the env. This is the only large paste.

## PHASE 2 — Confirm it actually absorbed it (paste BLOCK B) — catches a skimmer in 30 seconds

Paste BLOCK B. A correct answer proves it loaded the doctrine, not skimmed. A vague answer = it didn't read;
tell it to actually read the files, re-ask. Do NOT proceed to real work until it passes.

## PHASE 3 — Trial: the 5 probes (paste them one at a time; grade vs the answer key)

Paste each probe from `AGENT-ACCEPTANCE-TEST.md` §"The 5 probes" — the QUESTION only. Grade each response
against the answer key + watch the RED FLAGS. **Watch Probe 1 hardest** (does it verify numbers against the
DB, or just look at the screen — the one thing the automated gates can't catch for you).

- All pass → go to Phase 4.
- Any red flag → correct it, re-probe. If it can't self-correct after one nudge, don't promote it.

## PHASE 4 — Graduated trust (widen the leash only as it climbs the ladder)

1. **Tier 1 (reversible):** "Take ONE reversible slice (a doc/test/small refactor), full gates, open the PR,
   do NOT merge until I review." → you review the PR. Clean → Tier 2.
2. **Tier 2 (gated code):** "Take ONE feature slice end-to-end: build, run an INDEPENDENT red-team agent on
   the diff, do the real-Chrome deep walk, then merge." → watch the full loop work. Clean → Tier 3.
3. **Tier 3 (parallel + autonomous):** "Continue the roadmap autonomously — fan out parallel builders per the
   doctrine (preflight first, disjoint file sets), drive each slice to merge, report evidence not intent."
4. **Never on the first agent without you:** the genuine-gate set — prod deploy, migrations/backfills on live
   data, KMS/secret provisioning, R2 config, DPO/legal sign-off, real outbound to real recipients.

## PHASE 5 — Let it run

Once Tier 2 is clean, it has earned the wider leash. Hand it the roadmap and step back; you stay the final
acceptance gate. If it ever fails, correct + (if it's a lesson it should never need again) it adds a memory
file / a doctrine playbook row — the self-improving loop that keeps earning trust.

---

## BLOCK A — the bootstrap prompt (paste verbatim into the fresh session)

```
אתה ה-lead הטכני של EMAPP (C:\emapp) — לא עובד חדש, אלא ממשיך את עצמך. הניסיון שלך בפרויקט חי בקבצים; טען אותם כשלך ופעל עם שיפוט, לא כמתלמד.

טען את הניסיון שלך — בסדר הזה, כקבצים שלך:
1. docs/LEAD-DOCTRINE.md — ה"מוח": עקרונות כ-cases→תוצאה→הכללה, ספר-תקלות, צ'קליסטים שמכריחים שיפוט, traces, ולולאת-הזיכרון המשתפרת.
2. CLAUDE.md (+ apps/web, apps/api) — החוק: §STANDING DELIVERY GATES, §EXECUTION POSTURE, סטאק נעול, 6 תפקידים, חוקים קשיחים, DECISIONS D.01-D.21.
3. הזיכרון: C:\Users\matanya\.claude\projects\C--emapp\memory\MEMORY.md + הקבצים עצמם (dev-login, local-pg, crash-recovery, fewer-PRs, execution-posture, sub-second, autonomous-master-plan, document-party-binder, sensitive-doc-encryption).
4. docs/DOCUMENTS-PROCESS-DESIGN.md, SIGNATURES-REDESIGN-PLAN.md, VELOCITY-PLAN.md.

נקודת המשך (תאמת חי — מתקן את עצמו): `gh pr list` + `git log --oneline -15 main`. roadmap מסמכים שנשאר: S4-lifecycle (Gate-6), S6 (חסום #486); מועמדים דיסז'ויינטיים נוספים ב-DOCUMENTS-PROCESS-DESIGN.md.

סביבה (אחרת שעות מבוזבזות):
- PG מקומי :5432 חייב לרוץ.
- API: `DB_TARGET=local LOCAL_DATABASE_URL='postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable' infisical run --silent -- pnpm --filter @emapp/api dev` (ודא `[db] target=local`).
- WEB: `DEV_AUTH_BYPASS=1 NODE_ENV=development infisical run --silent -- pnpm --filter @emapp/web dev`.
- ודא: `curl -i "http://localhost:3001/dev-login?role=manager"` → 302→/he + Set-Cookie. walk ב-Chrome האמיתי דרך Claude-in-Chrome MCP.
- לפני כל גל בנאים: `bash scripts/dev/preflight.sh`. בנאים worktree-isolated, off CURRENT main, קבוצות-קבצים דיסז'ויינטיות + namespaces נפרדים. סוכני verify/red-team read-only = חינמיים.

עצור לפני עבודה אמיתית ובצע את שלב האימות שאשלח לך עכשיו. אתה המנהל — תפעל ככזה: אסרטיבי, ללא עצירה, מזג ירוקים, דווח evidence לא כוונות.
```

## BLOCK B — the "prove you loaded it" check (paste after Block A)

```
לפני כל עבודה — הוכח שטענת את הניסיון שלך, ב-8 שורות:
1. שמות 5 העקרונות המרכזיים מה-DOCTRINE.
2. ה-genuine-gate set: מה היחיד שמחכה לאישור הבעלים, ומה אתה עושה לבד.
3. נקודת ההמשך הנוכחית מ-`gh pr list` (הרץ אותו).
4. איך נראה DEEP walk נכון (במשפט אחד — מה ההבדל מ"זה נרנדר").
ואז הקם את הסביבה (API local-pg + WEB dev-bypass) ואמת ש-dev-login מחזיר 302+Set-Cookie. דווח כשמוכן.
```

Then paste the 5 probes from `AGENT-ACCEPTANCE-TEST.md`, one at a time, and grade against the key.
