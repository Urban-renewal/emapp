# Decisions for the owner — review at the end

Accumulated during the continuous gap-closing run. Each is a deliberation where I
picked a defensible default per the Charter (AUTONOMOUS-BACKLOG.md) and PROCEEDED
rather than stopping to ask. Review and override any you disagree with.

## Format

`[item] — DECISION: <what I did> · WHY: <rationale> · REVERSIBLE: <how to change> · NEEDS-YOU: <if anything>`

---

## D-O1 · SMS provider = Inforu (not 019)

- **DECISION:** Built `InforuSmsProvider` (packages/db/.../inforu.provider.ts) targeting Inforu's v2 JSON API as the concrete Israeli SMS gateway, behind a fail-fast factory.
- **WHY:** You said "019/Inforu" without specifying which account you'll open. Inforu has the cleaner documented JSON REST API. The provider-specific request/response shape is ISOLATED in `buildRequest()`/`parseResponse()` so switching to 019 is a one-method change, not a rewrite.
- **REVERSIBLE:** Yes — tell me which provider you actually have; I swap the two isolated methods (and the default `SMS_PROVIDER_API_URL`).
- **NEEDS-YOU:** (1) Open the Inforu (or 019) account; (2) put `SMS_PROVIDER_USER` / `SMS_PROVIDER_TOKEN` / `SMS_PROVIDER_SENDER` in Infisical; (3) confirm the live API shape matches `inforu.provider.ts` before first prod send (it carries a `VERIFY-BEFORE-GO-LIVE` note). Until creds exist, non-prod stays on Noop and **production refuses to boot** (fail-fast, same posture as the email provider) so SMS can never silently no-op in prod.
- **GO-LIVE VERIFY CHECKLIST** (the separated test-author flagged these — deferred until the account exists, because they can't be settled without the live API):
  - The provider maps only `StatusId===1` → `sent`, everything else → `rejected`. Confirm Inforu's success code is 1 and whether they expose an "accepted/queued" code we should map to `queued` (the contract supports it; today queued is folded into rejected).
  - On success the result `id` is the literal `'inforu'`, not a per-message id. If Inforu returns a message id in the response, wire it into `parseResponse` so sends are correlatable/de-dupable.
  - `toInternational` is a permissive FORMATTER, not a validator (the caller — OtpService.normalizeIsraeliPhone + owner-entry validation — is the gate). Garbage numbers are forwarded and the gateway rejects them. Confirm that's acceptable vs. adding provider-side length validation.
