# P6 — wire `branding.senderName` into the email From DISPLAY name

The config→behavior payoff of the OrgSettings seam: a per-org
`branding.senderName` now actually changes outbound email. Outbound emails use
the org's `OrgSettings.branding.senderName` as the From **display name**, while
the From **address** stays the verified system address.

## What was wired

A single pure helper — `buildEmailFrom(senderName, systemFrom)` in
`packages/db/src/providers/email/email-from.ts`, exported from `@emapp/db` — is
the ONE place that constructs a per-org From. It:

1. parses the verified **address** out of `systemFrom` (handles both a bare
   address `no-reply@x.co.il` and a display-name form `EMAPP <no-reply@x.co.il>`);
2. **sanitizes** `senderName` (see below);
3. returns `"<clean senderName> <verified-address>"`, or — if `senderName` is
   `undefined`/blank or sanitizes to empty — returns `systemFrom` **unchanged**.

The verified system From is the single constant `DEFAULT_EMAIL_FROM` (same file):
`env.EMAIL_FROM ?? 'EMAPP <no-reply@emapp.co.il>'`. `EMAIL_FROM` was added to the
`@emapp/db` env schema (optional; baked fallback so dev/test always works).

## SECURITY — display-name ONLY; custom from-ADDRESS is DEFERRED

- `branding.senderName` is used **only** as the From display name. The From
  **address** is ALWAYS the verified `DEFAULT_EMAIL_FROM`. `senderName` can
  never change the address.
- A per-org `branding.emailFrom` custom **address** is **NOT honored** and is
  **DEFERRED** until owner domain-verification exists. Reasons:
  - an arbitrary from-address is a **spoofing** vector (an org could send
    "as" any domain);
  - Resend / most MTAs **reject** a sender whose domain isn't verified — a
    custom from-address would break **deliverability** outright. A custom
    sending domain is an owner-provisioned EXTERNAL not available in MVP.
    The `branding.emailFrom` field stays in the schema (forward-compat) but is
    intentionally ignored by the email path today.

## SANITIZATION (header-injection guard — load-bearing)

`buildEmailFrom` → `sanitizeSenderName` strips, before the value reaches the
RFC 5322 From header:

- **CR / LF and all C0 controls** (U+0000–U+001F), **DEL** (U+007F), and **C1
  controls** (U+0080–U+009F) — a `\r\n` could inject a `Bcc:`/extra header or
  split the From header (CRLF smuggling).
- the RFC 5322 specials / quoting chars that would break or escape the
  display-name token or the address brackets:
  `"` `<` `>` `(` `)` `,` `:` `;` `\` `@` `[` `]`.
  These are **removed** (not escaped) so the rule stays one simple, safe pass
  that yields a clean **unquoted** display name.

Then internal whitespace is collapsed, the value is trimmed, and capped at 120
chars (the `branding.senderName` schema bound). **If nothing safe remains, the
helper falls back to the system default From entirely** (never emits an empty or
malformed display name).

The From also never carries recipient PII — it is built solely from org config
(`senderName`) + the system address.

## Send sites — WIRED vs LEFT ON DEFAULT

**Wired** (have clean org context — resolve `getOrgSettings(tx, orgId).branding.senderName`,
best-effort with default-From fallback on any read failure):

- `apps/api/src/modules/calendar-email/calendar-email.service.ts` — resolved
  inside the existing Phase-1 read `withTenant` tx and threaded onto every
  per-attendee send via the prepared payload.
- `apps/api/src/modules/members/members.service.ts` — authenticated Manager
  invite; resolved via a short `withTenant(user.orgId, getOrgSettings)` read
  before the send.
- The **signature-delivery** email sites (wired in the follow-up, PR #307):
  `signature-link-delivery.ts` (`deliverSignatureLink` / `notifyAfterSign` /
  `sendOne` / `sendInviteEmail`) now take an optional `from` and set
  `message.from` at the `email.send` boundary; the From is resolved at the
  callers via `resolveFromForOrg(tx, orgId)` =
  `buildEmailFrom(getOrgSettings(tx, orgId).branding.senderName, DEFAULT_EMAIL_FROM)`
  (best-effort, default-From fallback) — the 4 `deliverSignatureLink` call sites
  in `signature-requests.service.ts` and the `notifyAfterSign` call site in
  `public-sign.service.ts`. Covered by 6 real-DB tests
  (`signature-email-from.spec.ts`): From applied, default fallback,
  header-injection neutralized end-to-end, no token logged.

**Left on the system default** (no clean org/tenant tx — NOT contorted):

- `apps/api/src/modules/provider/provider-onboarding.service.ts` — runs in
  **provider** context for a **brand-new** org whose `settings` is the default
  `{}` (so `senderName` is `'EMAPP'` = the default anyway). There is no
  `withTenant(orgId)` tx in scope and `getOrgSettings` requires a `TenantTx`;
  resolving here would contort the architecture for zero behavior change.

_(The signature-delivery helpers were originally left on the default in the
first slice and have since been wired — see the Wired list above, PR #307.)_

## Best-effort contract

A settings-read failure at a wired site is caught and logged (non-PII) and the
send proceeds on `DEFAULT_EMAIL_FROM` — wiring the display name must NEVER break
email delivery.

## Gate

NOT Gate-6: no migration. `branding` already exists in the OrgSettings seam
(`organizations.settings` jsonb); only behavior (the From header) and a new
optional `EMAIL_FROM` env were added — no schema/RLS/enum change.
