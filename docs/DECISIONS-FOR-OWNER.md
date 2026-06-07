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

## D-O2 · Signature-link channel strategy = send SMS whenever a phone is on file

- **DECISION:** When a manager creates a signature request, the link auto-sends via EVERY available channel: email (if email on file) AND SMS (if phone on file), plus the WhatsApp deep-link is always returned for the manager to tap. SMS is no longer gated — it goes through the real provider in prod / Noop in dev.
- **WHY:** Israeli apartment owners are phone-first — most have a phone, many have no email on file (the schema makes email nullable, phone the primary contact). Sending SMS whenever a phone exists MAXIMIZES reach (the core job is collecting signatures). Email is best-effort on top.
- **COST NOTE:** This means an owner with BOTH email and phone gets contacted on both → ~1 SMS cost per such request. If you'd rather SMS only when there's no email (cheaper, less reach), that's a one-line change in `deliverSignatureLink`.
- **REVERSIBLE:** Yes — gate SMS on `!ctx.ownerEmail`, or add a per-org / per-request channel-preference setting (a natural follow-up enhancement).
- **NEEDS-YOU:** Confirm the always-SMS-when-phone default, or tell me to switch to SMS-only-when-no-email.

## D-O3 · Bulk signature-send token exposure (in the WhatsApp deep-link)

- **DECISION:** The bulk-send response (`POST /signature-requests/bulk`) returns a per-owner delivery report. The signing token is NOT a first-class field, but it IS present URL-encoded inside each owner's `delivery.whatsapp.deepLink` — exactly as the existing single-create `signUrl` is — so the manager can tap-send via WhatsApp. The separated test-author flagged this (consistent, not a new leak; the endpoint is gated by `signature_requests.send`).
- **WHY:** WhatsApp is a manager-driven channel; the deep-link must carry the link. Stripping it would break manual WhatsApp send. Kept consistent with single-create.
- **EXPOSURE NOTE:** A BULK response can carry up to 200 single-use 7-day tokens (vs 1 for single-create). If a bulk response is ever logged/screenshotted wholesale, that's a larger surface. It's returned to the manager FE over HTTPS and not logged server-side; pino redacts `/sign/` URLs (note: the deep-link encodes it as `%2Fsign%2F`).
- **REVERSIBLE / NEEDS-YOU:** If you want bulk treated as lower-trust, I can OMIT the `whatsapp.deepLink` from the BULK report (auto email+SMS still deliver) while keeping it for single-create. Say the word.

## D-O4 · Bulk-send duplicate-prevention is best-effort under CONCURRENT submits (MED, deferred)

- **CONTEXT:** Bulk-send skips owners that already have a PENDING request for the doc (a SELECT-then-skip). Under SERIAL retry (the common "did it work? click again") this prevents duplicates. But there is NO DB unique constraint, so two TRULY-CONCURRENT identical bulks (or a bulk racing a single-create) could both pass the skip-check and both insert → a duplicate pending request + a second signing link to the same owner. (Security review MED.)
- **WHY DEFERRED, not fixed now:** the proper fix is a partial unique index `CREATE UNIQUE INDEX … ON signature_requests (document_id, owner_id) WHERE status='pending'` — a Gate-6 migration that ALSO changes single-create's error handling (a racing insert would then raise 23505, which both paths must map to a clean "already pending" instead of a 500). That cross-path change + the migration's risk of failing on any pre-existing duplicate is best done as its own focused task, not rushed. Likelihood is LOW (requires simultaneous double-submit; the FE debounces + the endpoint is throttled 10/min).
- **NEEDS-YOU:** none — flagged for a follow-up task (added to AUTONOMOUS-BACKLOG). Tell me if you want it prioritized.
- **The sec-review HIGH (corrupt-ciphertext could abort the whole batch) WAS fixed** in this slice: the insert tx now does a decrypt-free `SELECT id` for visibility and PII is decrypted per-owner in ISOLATED txs during delivery — so a corrupt/key-drifted owner only fails ITS delivery, never the committed batch (regression test BULK-14).
