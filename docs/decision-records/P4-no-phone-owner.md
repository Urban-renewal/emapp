# P4 — Signature collection for a phone-less apartment owner

Status: accepted
Date: 2026-06-08
Area: signatures (apps/api/src/modules/signatures), shared-types contract
Related: D.12 (signing flow), D.19 (PII), D.20 (Tenant SMS-OTP), D.46 (agent gates)

## The gap

Some apartment owners have **no phone on file**. Two things break for them:

1. They cannot receive an **SMS-OTP**, so they cannot self-serve the resident
   portal. (The portal's only auth factor is SMS-OTP — D.20.)
2. They cannot be **SMS'd the signing link**, which is the primary automated
   delivery channel for phone-only owners (the common case — many owners have
   no email either).

Signature collection is the core product. It must not stall just because an
owner lacks a phone.

## Decision

### Portal access requires a phone — BY DESIGN (not a bug)

A phone-less owner cannot log into the resident portal. The portal's auth
factor is SMS-OTP (D.20); there is no fallback factor in MVP. This is accepted:
the portal is a convenience surface, not the signature-collection mechanism.

### Signature collection MUST still work — manager-driven, out-of-band delivery

For a phone-less owner the **manager** drives collection:

- The manager creates the signature request (individually or in a bulk send).
  A request row + a 7-day single-use JWT token are still minted. The `/sign/<token>`
  link is fully valid — the owner does NOT need to authenticate to sign (the
  token IS the credential; the public `/sign/:token` flow is unauthenticated by
  design, D.12).
- The manager retrieves that link and delivers it **out-of-band** — WhatsApp,
  email, printed paper — by whatever channel reaches that specific owner.

So the system must:

- **(a)** NOT fail a bulk/individual send because one owner lacks a phone —
  skip the SMS for that owner gracefully, still create the request + token,
  and report the SMS channel as unavailable (honest per-channel report).
- **(b)** Let the manager RETRIEVE the signing link for a request their org
  owns, to deliver it manually.

## What already held (no code change) — part (a)

The create / bulk / resend paths were **already graceful** for a phone-less
owner. Verified, not changed:

- `signature-requests.service.ts` `loadOwnerWithPii` returns `phonePlain: null`
  when `owners.phone_encrypted IS NULL` (the `CASE WHEN … THEN pgp_sym_decrypt …
ELSE NULL` branch). No throw.
- `signature-link-delivery.ts` `deliverSignatureLink` guards on `ctx.ownerPhone`:
  a null phone yields `sms: { available: false, reason: 'no_phone_on_file' }`
  and `whatsapp: { available: false, reason: 'no_phone_on_file_or_unparseable' }`
  — it does NOT throw. Email is attempted independently if an email is on file.
- Bulk (`createBulk`) gates once, inserts each request row, then delivers
  per-owner in **isolated** txs. Visibility uses a cheap id-only SELECT (no
  pgcrypto), so a phone-less / corrupt-ciphertext owner can never abort the
  batch. The request row + token are committed regardless; that owner is simply
  reported with no SMS delivery. The per-owner outcome stays `created`.

So a phone-less owner in a bulk send is already "created, SMS not delivered" —
exactly the required behaviour. No fix was needed for (a).

## What was missing (new code) — part (b)

The signing link was **write-only from the manager's side**: `signUrl` is
returned only at create/resend time. `GET /signature-requests/:id` deliberately
omits the token. For a phone-less owner created via **bulk**, `signUrl` is never
returned at all (bulk only ever surfaces the token inside the WhatsApp deepLink,
which is itself null without a phone). The manager had no way to obtain the link
to deliver it manually.

### New endpoint: `POST /api/v1/signature-requests/:id/link`

Returns `{ data: { request, signUrl } }` for a **pending** request the manager's
org owns. No delivery I/O — it's a retrieve-for-out-of-band-delivery action.

Mechanism (single source of truth): the original JWT is never stored (only its
`jti`), so it cannot be reconstructed. The endpoint re-mints a fresh token + new
7-day expiry and atomically swaps the row's `jti`/`expiresAt` WHERE still
pending — identical to `resend()`, minus the email/SMS send. The prior link
dies; the DB row's `jti` remains the one live credential. A signed/cancelled
request 409s (`signature_request_not_pending`) — nothing to deliver.

### Authorization (the signUrl is a BEARER credential)

Matches the SEND path exactly, NOT read:

- Coarse: `@RequirePermission('signature_requests.send')` (controller) — a
  read-only **Viewer** is rejected; `.read` would have leaked the credential.
- Fine: `requireAgentCapability(tx, user, 'manage_signatures')` in the service —
  an Agent without that capability is rejected (403). Agents also pass the
  document-visibility check (assigned project, else 404 — D.46), gated BEFORE
  the token is minted.
- Org scope: `withTenant(user.orgId, …)` + RLS — a foreign / unknown id is a
  no-oracle 404 with zero mutation.

Returning the link to an authorized manager does **not** widen exposure: that
same manager can already `resend()` the request, which SMS/emails this very
link. POST (not GET) because it mutates (re-mints `jti`); throttled 30/min like
resend.

### Security invariants held

- Token NEVER logged (no logger call references `token`/`signUrl`; same as the
  rest of the module).
- Token TTL (7d) and send-authz unchanged — not loosened.
- PII (phone, national_id) stays pgcrypto-encrypted, never logged.
- Audit: a distinct `signature_request.link_retrieve` action records who pulled
  the bearer link and when, even though no SMS/email was sent.

## Files

- `packages/shared-types/src/signature-request.ts` — added
  `SignatureRequestLinkResponseSchema` / `SignatureRequestLinkResponse`.
- `apps/api/src/modules/signatures/signature-requests.service.ts` — added
  `getLink()`.
- `apps/api/src/modules/signatures/signature-requests.controller.ts` — added
  `POST :id/link`.
- No change for (a) — verified `loadOwnerWithPii` + `deliverSignatureLink` +
  `createBulk` already handle a phone-less owner gracefully.

## Follow-on (FE, small)

A "copy signing link" affordance on the manager request-detail UI that calls
`POST /signature-requests/:id/link` and copies `signUrl` to the clipboard. Not
built here (BE-scoped slice); flagged as a small FE follow-on. Until then the
endpoint is callable directly / via the API client.
