# PLAN — Account Recovery & Business Continuity (Org + Provider tiers)

> Status: **PLANNING ONLY** (not built). Owner asked to keep this for planning, in detail.
> Source: read-only investigation of the OWNED auth stack (D.21), 2026-06-09.
> Drives: a future Gate-2/Gate-6 auth-recovery slice. Nothing here is implemented yet.

## 0. Why this matters

EMAPP holds Israeli PII (national_id, phone, signatures) → the **Privacy
Protection (Data Security) Regulations 2017 "high tier"** (RBAC + access logging

- encryption + periodic review). Account-recovery is the business-continuity leg
  of that posture: a locked-out admin who cannot recover is both an availability
  incident and (if "recovery" means ad-hoc DB surgery) a security incident.

The current stack is **strong on cryptographic hygiene** (argon2id, hashed
refresh, rotation + reuse-detection, session revocation on both tiers) and
**weak on the "human is gone / human forgot" continuity cases**. This plan
closes the second.

---

## 1. Current state — verified, grounded (what EXISTS vs GAP)

### 1a. Org tier (Owner / Manager)

| Scenario                                  | Today                                                                                                                                                                                                                                                                                                                | Gap                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Forgot / lost password                    | **No self-service reset exists at all** — `auth.controller.ts` exposes only signup/login/refresh/logout/switch-org; login page has no "forgot password". 5-fail lock self-heals after 15 min, but a forgotten password is unrecoverable by the user.                                                                 | **No password-reset flow. #1 gap.**                                                         |
| Lost MFA                                  | Org MFA is **not wired** — `users.mfaSecretEncrypted`/`mfaEnabledAt` columns exist but `auth.service.login` never reads them; no enroll endpoint.                                                                                                                                                                    | No org MFA offered (so no lost-MFA scenario — but also no second factor).                   |
| Compromised session                       | Revocable: `logout` purges all sessions; refresh reuse-detection purges the chain; revoking/role-changing a member kills their sessions.                                                                                                                                                                             | Provider has **no lever to revoke a single org-manager's session** (only org-wide suspend). |
| Departed employee                         | `members.revoke` kills sessions + deletes role_assignments; `assertNotLastManager` blocks removing the last manager.                                                                                                                                                                                                 | Needs a **surviving manager**; no auto-reassign of the departed user's projects.            |
| **Sole Owner gone** (left / dead account) | Only safety net is `assertNotLastManager` (prevents removal, useless if already gone). Provider can CREATE a new org + manager and reuses an existing user row, but **only ever creates a NEW org** — never re-invites into an existing one. `org.transfer_ownership` permission is **defined but has no endpoint**. | **Single-Owner = single point of failure → recovery = manual DB surgery.** #2 gap.          |

### 1b. Provider tier (Provider Admin) — stronger

| Scenario                 | Today                                                                                                 | Gap                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lost MFA device          | **8 single-use recovery codes** (hashed at bootstrap, accepted in place of TOTP, consumed on use).    | Codes printed once; if lost → next row.                                                                                                                                                                       |
| Lost MFA **and** codes   | `bootstrap-provider-admin.ts --reset-mfa <email>` re-issues password + MFA secret + codes.            | **Requires infra access** (Infisical DB creds). No in-product self-recovery.                                                                                                                                  |
| Account lockout          | 5 fails → 15-min silent lock; never permanent; success resets it.                                     | Sustained spray can keep a legit admin in a rolling lock (DoS); `--reset-mfa` is the only escape.                                                                                                             |
| Compromised / sole admin | Sessions revocable (logout + reuse-detection). `disabledAt` column blocks login/`/me`.                | **No code path SETS `disabledAt`** (no admin-management endpoint) + **no 2nd-admin requirement** → a compromised sole admin can't be disabled by a peer. **Single provider admin = single point of failure.** |
| Session revocation       | `provider_sessions`, SHA-256 hashed refresh, rotation + reuse-detection, 30-min access / 4-h refresh. | Solid — no gap.                                                                                                                                                                                               |

---

## 2. Real-world best practice (the bar we're aiming at)

Sources: OWASP Forgot-Password & MFA cheat sheets; Microsoft Entra emergency-access guidance.

1. **Never a single admin** — require ≥2 Owners / ≥2 break-glass admins so one lockout is never fatal (Microsoft: 2 permanent emergency-access accounts, stored so multiple people can reach the credentials).
2. **Self-service password reset** — single-use, time-limited, rate-limited, anti-enumeration email token; purge sessions on reset.
3. **MFA recovery codes** — single-use, issued at enrolment (provider tier already does this).
4. **Break-glass / sealed emergency admin** — a declared, alerted, post-hoc-reviewed path distinct from routine recovery.
5. **Vendor / infra-level recovery as the LAST resort** — not the first (today the org tier has _only_ this).
6. **Departed-employee offboarding** — revoke + reassign, ideally bulk.

---

## 3. Recommendations — phased

### Phase R0 — Quick wins (days)

1. **Org self-service password reset (the #1 gap).**
   - New `password_reset_tokens` table: `id, user_id, token_hash (sha256), expires_at (≤30 min), used_at, created_at`. RLS via user/org.
   - `POST /auth/forgot-password` (email only) → always 200 (anti-enumeration, like signup); if the email exists, mint a single-use token + email a reset link via the **existing** `invite-email.ts` channel.
   - `POST /auth/reset-password` (token + new password) → argon2id via the existing `password.ts`; on success, **purge ALL the user's sessions** (mirror `logout`), consume the token, audit.
   - OWASP-aligned: single-use, short TTL, rate-limited, generic responses, no token in logs.
   - **Gate:** auth surface → builder + **security-review** + owner sign-off before merge.

2. **Provider peer-disable endpoint.** `POST /provider/admins/:id/disable` (provider write, audited) that SETS the already-read `disabledAt` + revokes that admin's sessions. Turns the dead `disabledAt` column into a real compromise lever, and is the prerequisite for a 2-admin model.

3. **Operationalize the provider break-glass** (no code): a runbook for `--reset-mfa` with a tested restore drill, and the one-time recovery codes stored in a **shared secret vault** (so >1 person can reach them — Microsoft principle).

### Phase R1 — Remove single points of failure (weeks)

4. **≥2-Owner posture.** Let onboarding seed (or require) a second Owner; add `assertNotLastOwner` alongside the existing `assertNotLastManager`. Applies to BOTH tiers (≥2 provider admins too).

5. **Provider "re-provision into existing org" + ownership transfer.** Wire the already-defined `org.transfer_ownership` permission to a real endpoint, and extend `provider-onboarding.service.ts` to **re-invite a manager into an EXISTING org** (today it only creates new orgs). This is the correct fix for "sole Owner left the company" — replaces manual DB surgery. **Audited + access-reason gated** (it's a provider write into a tenant — same governance as suspend/onboard).

6. **Bulk reassignment on offboarding** — reassign a departed user's projects/assignments, not just revoke.

### Phase R2 — Optional hardening

7. Org-tier optional MFA (wire the dead columns) + recovery codes, for security-sensitive orgs.
8. Tie recovery events into the customer-visible **Access Transparency** surface (see PLAN-provider-console.md) so an org sees "a reset was performed / EMAPP staff re-provisioned an admin".

---

## 4. Gate classification

- Password-reset, peer-disable, transfer-ownership: **Gate-2** (auth architecture) + **Gate-6** (new tables / new endpoints). Owner sign-off required; security-review mandatory (auth surface).
- The runbook + vault items: process, no code.

## 5. Priority

**R0.1 (org password reset)** is the single highest-impact item — without it, a manager who forgets a password is stranded behind manual DB surgery. Recommend it as the first auth-recovery slice.
