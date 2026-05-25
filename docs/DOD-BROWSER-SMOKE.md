# Mandatory Browser-Smoke DoD (Phase 4a+)

**Effective:** 2026-05-25 (post-S11)
**Trigger:** any slice that adds or changes UI interaction — form, button, link that changes state, navigation.

## Why

The S1 GET-form bug (login submitted credentials via URL because the SSR HTML lacked `method="post"`) shipped because RTL synthesized events differently than real browser HTML behavior. Unit + integration tests passed. The user found it by inspecting the rendered HTML. This is a class of bug that jsdom **cannot** catch. We add a runtime browser verification to close the gap.

## The four axes — verify ALL of them before closing a slice

For every new interaction, run the following 4-axis check **in a real browser**, not in jsdom:

```
1. Start: infisical run --env=dev -- pnpm --filter @emapp/web dev   (+ API + DB)
2. Open: http://localhost:3001 with DevTools (Network + Application + Console)
3. Perform the interaction.
4. Verify ALL FOUR:
   ▪ Network: request fired to the EXPECTED URL with the EXPECTED method.
              POST for mutations (not GET). Content-Type + body match Zod.
   ▪ URL:     after the interaction, the URL in the address bar does NOT
              contain any form field name or value. No `email=`, no `password=`,
              no UUID, no PII. This catches the "form without method='post'
              + no onSubmit/preventDefault" bug class definitively.
   ▪ Cookies: (if relevant) Set-Cookie has no `Domain=` attribute,
              has `HttpOnly`, has `SameSite=Lax`, `Secure` per env (D.21).
   ▪ Redirect: (if relevant) the redirect target is the expected one,
              preserves locale, no open-redirect.

5. If ANY of the 4 fails — fix at root cause. Not a test patch.
6. If you don't want to do 1-5 manually — add a Playwright test that
   exercises the SAME 4 axes, in the same slice (NOT deferred).
```

## The view-source self-check

Before opening a slice PR, open `view-source:` on every page you changed. If you see a `<form>` element that:

- has no `method="post"` attribute, AND
- has no inline `onSubmit` that calls `preventDefault()`

→ that form is going to GET-submit credentials to the page URL. Fix it.

The static check in `apps/web/src/app-forms-no-get-fallback.spec.ts` automates this for every `<form>` in `apps/web/src/app/` — keep it green.

## Coverage matrix — what counts as an "interaction"

| Component             | Smoke needed?       | Why                                                                             |
| --------------------- | ------------------- | ------------------------------------------------------------------------------- |
| `<form>` with submit  | YES                 | GET-fallback risk; check method="post" + Network                                |
| `<button>` that posts | YES                 | Network + Redirect                                                              |
| `<Link>` (Next.js)    | NO (unless dynamic) | Client-side nav; pre-rendered                                                   |
| Read-only display     | NO                  | No state change                                                                 |
| File upload form      | YES (extra)         | Same as form + verify the FormData/XHR path is taken (not URL-encoded fallback) |
| OAuth / SAML redirect | YES                 | Verify the redirect URL is allow-listed                                         |

## When the test is infeasible

Some interactions need a live BE you can't easily fixture (e.g. R2 presigned PUT, SSE stream). For those:

- Run the 4-axis manually once before the slice closes.
- Document in PROGRESS.md heartbeat what you smoked.
- Add the test to TODO/`it.skip` with the reason, so a later slice with a BE fixture can fill it in.

## OPEN-ITEMS entry

The S1 GET-form bug is recorded as `§S1-VG1` ("S1 closed without manual browser smoke; verification gap exposed by user, not by self-audit") in [OPEN-ITEMS-v9-PHASE4A-AUDIT.md](../OPEN-ITEMS-v9-PHASE4A-AUDIT.md). This DoD is the closure for that gap.
