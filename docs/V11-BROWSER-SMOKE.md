# V11 Browser Smoke Standard

> **Mandatory** after every slice. No PR is mergeable without this evidence in its description (G4).
> **Self-verifying:** the agent runs this, posts evidence, and continues. No human approval in the loop.

---

## Division of labor — Chrome extension vs Playwright

V11 uses **both tools**, in different roles, with no duplication.

| Track                         | Tool                                    | Purpose                                                                                | Cadence                                           |
| ----------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **A — Design Re-skin**        | **Chrome extension** (Claude in Chrome) | "Does it look + work right now?" — visual + UX + RTL + security probe per slice        | Every slice (one-time check)                      |
| **B — BE Specialist**         | **Chrome extension** + curl             | "Does the endpoint behave + does one FE consumer still work?" — per-slice verification | Every slice (one-time check)                      |
| **D — Playwright (existing)** | **Playwright** in `apps/web/e2e/`       | "Will it stay working forever?" — codified regression net, runs in CI on every PR      | After A's slice merges, D writes test in Wave 2/3 |

### Why this split

- Chrome extension catches what Playwright can't (visual misalignment, RTL hover, font rendering, animation glitches, real DevTools cookie/network inspection).
- Playwright catches what Chrome extension can't (long-term regression, deterministic reruns in CI).
- Different cadences — no effort duplication.
- No race — D writes regression test **after** A's slice merges, not in parallel.

### Setup per agent (one-time, session start)

- **Track A + Track B agents:** pair Chrome via the Claude-in-Chrome MCP extension before starting the canary slice. Verify with a `list_connected_browsers` call. If pairing fails → STOP, post evidence, await user.
- **Track D agent:** continues with Playwright in `apps/web/e2e/`. No browser pairing needed.

### When Chrome extension isn't available

Track A/B agent **falls back to Playwright** (same `apps/web/e2e/` setup) and posts the same evidence shape (all 4 axes, all roles, additions). **Never skip the smoke; downgrade the tool.** Note the downgrade in the PR description so D can prioritize covering it.

---

## The rule

Before declaring a slice "done":

1. Open a real Chrome (DevTools open: Network + Console + Application/Cookies).
2. Simulate **every user role relevant to the slice** end-to-end.
3. For each role, verify **all 4 axes** pass:
   - **Functionality** — the action works as designed.
   - **Performance** — under target latency, no customer waiting.
   - **Security** — attacker manipulations don't succeed.
   - **Error handling** — graceful failures, no internals leak.
4. For each axis, **add at least 1 slice-specific check** (not generic).
5. Paste evidence in the PR description (template below).

**All-or-nothing:** one failed check = fix root cause → re-run all checks from scratch → max 5 attempts → STOP.

---

## What counts as evidence (and what doesn't)

**Evidence is raw output a reviewer can copy-paste. Not paraphrase. Not a status report.**

If your PR description reads like a summary instead of a debug session paste, it's paper analysis — and the PR is blocked at review regardless of how many ✓ marks you put next to checks. Tighten this yourself before posting; don't make the reviewer catch it.

### ✅ Counts as evidence

- `curl -v` output with full status line + response headers + body, pasted into a fenced code block
- DevTools Network tab screenshot showing request URL, method, status code, response headers, and cookies set
- DevTools Console paste (verbatim) showing actual logged lines or `(empty)` if clean
- `view-source:` paste of the disputed element (e.g. the `<form>` tag to prove `method="post"`)
- DevTools Application → Cookies screenshot showing `HttpOnly` / `SameSite` / `Secure` flag columns
- `document.cookie` paste from Console — proves what's exposed to JS
- Performance panel screenshot with actual LCP / FID / CLS numbers visible

### ❌ Does NOT count as evidence

- "I verified that the endpoint returns 404"
- "Axis 3 passed — cross-tenant leak prevented"
- "✓ No console errors"
- "I checked and the cookie is HttpOnly"
- "Service tests pass (158/158)" — service tests bypass the HTTP layer entirely
- "Playwright spec covers this scenario" — covered ≠ smoked for this slice
- "All unit tests green" — irrelevant to the smoke gate
- Any sentence that starts with "I confirmed", "I verified", "I checked", or "✓" without a paste below it

### Why this matters (the breach this section was written to prevent)

Service-level tests, unit tests, and Playwright runs **bypass the integration layers production traffic actually traverses**: JWT verification in guards, audience checks, Fastify body parsing, `ZodValidationPipe` in controllers, the `{data}` envelope, the throttler, idempotency interceptors, the global exception filter (D.16), cookie middleware, CSP headers, CORS preflight.

If you didn't watch a real request go through these layers and capture the output, **you don't have evidence — you have intent**. A PR that claims smoke evidence based on service-level tests is misrepresentation, even if the underlying code is correct. The harm isn't (only) the slice — it's the trust collapse: once "paper smoke" is accepted, the entire G4 net unravels for every future slice on every track.

If you find yourself writing "I verified X" without a corresponding paste, **stop writing the PR description and go run the actual command**.

---

## Per-axis baseline (mandatory)

### Axis 1 — Functionality

- New button/link/form triggers the expected request (correct URL, method, body).
- URL after action does NOT contain inputs (no PII leak via `?email=` or similar).
- DOM updates to real data (not skeleton/placeholder forever).
- Navigation/redirect happens as expected.
- Hebrew + RTL render correctly.
- No leftover lorem ipsum / placeholder colors.

### Axis 2 — Performance

- Each action's round-trip < 200ms (p95) on Fast 3G throttle.
- LCP < 2.5s, FID < 100ms, CLS < 0.1.
- 10 navigations in a row → memory heap doesn't grow monotonically.
- SSE/long-poll connections close cleanly when tab closes.

### Axis 3 — Security (attacker probe)

Pick at least 5 relevant to the slice:

- **URL manipulation** — change UUID in URL to another org's → expect 404 (no oracle), not 403.
- **Cookie manipulation** — modify `access_token` cookie value → expect 401 + cookies cleared.
- **Token deletion** — delete cookies → expect redirect to /login.
- **Cross-tenant fetch** — manual `fetch('/api/v1/<other-org-resource>')` in Console → expect 404.
- **Mass-assignment** — `fetch` POST with extra fields (e.g., `organizationId`, `createdBy`) → expect 400 strict validation.
- **DOM manipulation** — Viewer/Agent removes `disabled` attribute from a Manager-only button → click → expect 403 from BE.
- **XSS** — input `<script>alert(1)</script>` in a text field → expect rendered as text, not executed.
- **`document.cookie` in Console** — should NOT show `access_token` (HttpOnly).

### Axis 4 — Error handling

- DevTools Network → Offline → action fails → user-facing message in Hebrew, no raw error.
- Slow 3G → loading state visible, no flicker.
- BE 500 (stop API and try) → error envelope generic, no internals.
- BE 4xx → FE switches on `error.code`, not `message`.
- Cancel mid-action (close tab, navigate away) → BE doesn't crash, FE recovers.

---

## Per-axis agent additions (mandatory ≥ 1 per axis)

For every axis, the agent must add at least **one slice-specific check** that's:

- **Unique** — not duplicating a baseline check.
- **Relevant** — exercises something specific you wrote in this slice.
- **Justified** — explain why you added it.

**Examples of strong additions:**

- "I changed `owners.name` encryption — added: search by partial name returns hits even with bidi chars in payload (ב.S3 closure)."
- "I added a new endpoint with idempotency-key — added: two parallel POSTs with same key + different body → server rejects 422, doesn't double-save."
- "I implemented the WeekCalendar grid — added: rendering 100 tasks in one day cell stays <50ms with virtualization."

**Examples of weak additions (rejected at review):**

- "Verified it doesn't crash." (Not measured.)
- "Checked it's fast." (Not specific.)
- "Tested it." (No detail.)

---

## Role calibration per slice

Identify which roles are relevant to your slice. Only test those.

| Slice type                                  | Roles to simulate                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| Login / Signup / Logout                     | Manager + Agent + Viewer + Tenant (OTP)                                    |
| Project CRUD / Building / Apartment / Owner | Manager (success) + Viewer (read-only enforcement) + Agent (assigned-only) |
| Documents / Imports / Signatures            | Manager + Viewer + Agent                                                   |
| Members / Audit / Settings                  | Manager only + Viewer (403 path)                                           |
| Tenant Portal                               | Tenant (OTP login) + Org user (cross-tier 401)                             |
| Provider Admin                              | Provider Admin (with MFA + access_reason) + Org user (cross-tier 401)      |
| Calendar (create task)                      | Manager + assigned Agent + related Tenant (if invited)                     |
| Typography / pure visual change             | 1 role (Manager) — shortened smoke                                         |

---

## Calibration by risk

Smoke depth scales with what changed:

| Change type                          | Smoke time budget                                                           |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Typography / color / spacing only    | 10 min · 1 role · functionality + console clean                             |
| Component reskin (no logic change)   | 20 min · 2 roles · all 4 axes baseline                                      |
| New feature (UI + BE)                | 60-90 min · all relevant roles · all 4 axes baseline + ≥1 addition per axis |
| Schema migration                     | 45 min · BE smoke via curl + 1 FE consumer · rollback verified              |
| Security-sensitive (auth/policy/PII) | 90 min · full security probe + extra additions                              |

---

## PR description template (use this verbatim)

> Every ✓ below must be followed by a raw-evidence fenced code block (curl output, console paste, or screenshot reference). Ungrounded ✓ marks are paper analysis — see "What counts as evidence" above. If you can't paste the raw output, you didn't run the check.

```markdown
### Browser Smoke Evidence (V11-BROWSER-SMOKE)

**Smoke time:** ~XX min · **Roles tested:** [list]
**Tool used:** Chrome MCP extension · session id: [from list_connected_browsers]
(or: Playwright fallback — note why Chrome was unavailable)

#### [Role 1 — e.g., Manager]

**Journey:** [describe the end-to-end flow in 1 sentence]

**Axis 1 — Functionality:**

- ✓ Baseline check 1 — raw evidence:
```

$ curl -v -X POST http://localhost:3001/api/v1/...
< HTTP/1.1 200 OK
< Content-Type: application/json
{"data":{"id":"..."}}

```
- ✓ Baseline check 2 — DevTools Network screenshot: [link or paste]
- ✓ **Addition:** [slice-specific check] — raw evidence: [paste]

**Axis 2 — Performance:**
- ✓ Action X: Yms (target <200ms) — DevTools Network timing screenshot showing the number
- ✓ LCP: Xs — Performance panel screenshot
- ✓ **Addition:** [...] — [paste]

**Axis 3 — Security:**
| Attack | Result | Pass? |
|---|---|---|
| Cross-tenant UUID | 404 no_found | ✓ |
| Viewer POST | 403 forbidden | ✓ |
| **Addition:** [name] | [result] | ✓ |

**Axis 4 — Error handling:**
- [✓/✗] Offline: graceful toast
- [✓/✗] BE 500: generic envelope
- [✓] **Addition:** [...]

#### [Role 2 — e.g., Viewer]
[repeat structure]

#### [Role 3 — e.g., Agent]
[repeat structure]

#### Cross-check
- [✓] Console: zero errors, zero warnings, zero CSP violations
- [✓] Network: all calls to /api/v1/, no third-party
- [✓] Cookies: hostOnly, HttpOnly, SameSite=Lax (Secure absent in dev — expected per `auth.service.ts:58`)
- [✓] Smoke attempts: 1/5 (passed first time)
```

---

## When a check fails

1. **Stop pushing forward.** Do not commit "I'll fix it next slice."
2. **Find root cause.** Not a patch — the underlying reason.
3. **Re-run the entire smoke** for the slice (all roles, all axes). Partial re-run = not allowed.
4. **Max 5 attempts.** After the 5th failed attempt → STOP, post the attempts trail, await user.

---

## Backfill protocol (when paper smoke is discovered after the fact)

If a PR was opened or merged with paper smoke (paraphrased evidence instead of raw output), the breach must be backfilled — not waived, not "remembered for next time."

### For an OPEN PR

1. **STOP new slice work immediately.** No new commits, no new PR openings, until the backfill is posted.
2. Run the full smoke per this standard, with raw evidence.
3. **Edit the PR description** — replace the paraphrased evidence with the raw output. Add a top-of-description note: `### ⚠️ Smoke backfilled — original evidence was paper analysis. See commit-thread comment for honest account.`
4. Post a PR comment with: (a) what was originally claimed, (b) what the actual smoke found, (c) whether any bug was discovered.
5. Only after evidence is posted and reviewer confirms → merge is unblocked.

### For an ALREADY-MERGED PR

1. **STOP new slice work immediately.** Same rule.
2. Run the smoke retroactively against the merged code on `main`.
3. Post a comment on the merged PR with raw evidence.
4. If a bug is found: open a NEW fix PR. **Never rebase-and-force** the merged PR.
5. Post a heartbeat in `PROGRESS.md` listing every prior PR on the track + smoke status (`real ✓` / `paper ✗ → backfilled at <link>`).
6. Only after the audit-pass heartbeat is posted → new slice work resumes.

### Why this is non-negotiable

Paper smoke that goes unchallenged becomes the norm. One slice of paraphrased evidence accepted = every future slice on every track is suspect. The backfill is the only path that restores the gate without throwing away the work.

---

## Cheat sheet — common gotchas

- **CSP `unsafe-eval` only in dev** (per PR #47) — production smoke must NOT see eval errors.
- **`Secure` cookie absent in dev** — that's correct (per `auth.service.ts:58`), do not flag.
- **`page.route('**/api/**')` in Playwright** does NOT intercept Next.js Server Component fetches — use `context.addCookies()` for server-side login simulation.
- **`t.rich` callback signature** must be `(chunks) => ...`, not `() => ...` (per PR #61). Console will throw "Functions are not valid as a React child" if wrong.
- **Form `method="post"`** is defense-in-depth (per PR #47) — never remove from form elements even if `onSubmit` exists.
- **`createdBy === user.sub`** check on cancel/submitMapping (v8 Sec-8) — don't break.

---

This is the entire standard. No separate security checklist, no separate per-slice protocol. One doc, every slice.
