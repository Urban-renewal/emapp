# V11 Browser Smoke Standard

> **Mandatory** after every slice. No PR is mergeable without this evidence in its description (G4).
> **Self-verifying:** the agent runs this, posts evidence, and continues. No human approval in the loop.

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

| Slice type | Roles to simulate |
|---|---|
| Login / Signup / Logout | Manager + Agent + Viewer + Tenant (OTP) |
| Project CRUD / Building / Apartment / Owner | Manager (success) + Viewer (read-only enforcement) + Agent (assigned-only) |
| Documents / Imports / Signatures | Manager + Viewer + Agent |
| Members / Audit / Settings | Manager only + Viewer (403 path) |
| Tenant Portal | Tenant (OTP login) + Org user (cross-tier 401) |
| Provider Admin | Provider Admin (with MFA + access_reason) + Org user (cross-tier 401) |
| Calendar (create task) | Manager + assigned Agent + related Tenant (if invited) |
| Typography / pure visual change | 1 role (Manager) — shortened smoke |

---

## Calibration by risk

Smoke depth scales with what changed:

| Change type | Smoke time budget |
|---|---|
| Typography / color / spacing only | 10 min · 1 role · functionality + console clean |
| Component reskin (no logic change) | 20 min · 2 roles · all 4 axes baseline |
| New feature (UI + BE) | 60-90 min · all relevant roles · all 4 axes baseline + ≥1 addition per axis |
| Schema migration | 45 min · BE smoke via curl + 1 FE consumer · rollback verified |
| Security-sensitive (auth/policy/PII) | 90 min · full security probe + extra additions |

---

## PR description template (use this verbatim)

```markdown
### Browser Smoke Evidence (V11-BROWSER-SMOKE)

**Smoke time:** ~XX min · **Roles tested:** [list]

#### [Role 1 — e.g., Manager]
**Journey:** [describe the end-to-end flow in 1 sentence]

**Axis 1 — Functionality:**
- [✓/✗] Baseline check 1
- [✓/✗] Baseline check 2
- [✓] **Addition:** [slice-specific check, with rationale]

**Axis 2 — Performance:**
- [✓/✗] Action X: Yms (target <200ms)
- [✓/✗] LCP: Xs
- [✓] **Addition:** [...]

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

## Cheat sheet — common gotchas

- **CSP `unsafe-eval` only in dev** (per PR #47) — production smoke must NOT see eval errors.
- **`Secure` cookie absent in dev** — that's correct (per `auth.service.ts:58`), do not flag.
- **`page.route('**/api/**')` in Playwright** does NOT intercept Next.js Server Component fetches — use `context.addCookies()` for server-side login simulation.
- **`t.rich` callback signature** must be `(chunks) => ...`, not `() => ...` (per PR #61). Console will throw "Functions are not valid as a React child" if wrong.
- **Form `method="post"`** is defense-in-depth (per PR #47) — never remove from form elements even if `onSubmit` exists.
- **`createdBy === user.sub`** check on cancel/submitMapping (v8 Sec-8) — don't break.

---

This is the entire standard. No separate security checklist, no separate per-slice protocol. One doc, every slice.
