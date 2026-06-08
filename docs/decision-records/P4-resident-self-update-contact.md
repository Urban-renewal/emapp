# P4 — Resident self-update contact (EMAIL-only this slice)

Status: accepted
Date: 2026-06-08
Branch: `task/p4-resident-self-update`
Gate-6: NO (no migration, no RLS change, no schema change)

## Scope

A logged-in resident (tenant tier, OTP-authenticated to THEIR OWN owner
record via the `emapp-tenant` JWT) can self-update their OWN **email** only.

- **email** — writable (plaintext `citext` column; matches the existing
  `owners.email` storage — NOT encrypted, so no pgcrypto round-trip).
- **phone** — DEFERRED to a follow-on slice. Phone is the SMS-OTP auth
  factor, so changing it must OTP-verify the NEW number first (prove the
  resident controls it before we cut over the login factor). That needs a
  new challenge primitive + a migration (pending-phone-change table or
  column) and is its own Gate-6 slice. This slice leaves the phone row
  READ-ONLY in the UI with an i18n note "to change your phone, contact the
  team".
- **national_id** — IMMUTABLE. Enforced structurally by the DTO shape:
  `PortalUpdateContactSchema` is `.strict()` and contains ONLY `email`, so
  any `national_id` (or `phone`, `name`) key in the body is a 400 before
  the service runs. No mass-assignment surface.

## Security invariant (the headline)

The `owners` RLS policy is **ORG-scoped** (`org_id = app.organization_id`),
NOT own-row. RLS alone would let a resident UPDATE ANY owner in their org.

The own-row guarantee is therefore **100% application-layer**:

```
tx.update(owners)
  .set({ email, updatedAt })
  .where(and(eq(owners.id, tenant.sub), isNull(owners.archivedAt)))
```

`tenant.sub` is the authenticated owner id from the guard-verified JWT.
There is NO id in the request body or path — the identity is the `sub`
claim only. Weakening this WHERE (dropping `eq(owners.id, tenant.sub)`)
would turn the endpoint into an org-wide owner-email overwrite. Do not.

0 rows updated → `NOT_FOUND` (no oracle; same posture as the read paths
and `resendForOwner`).

## PII discipline

- `email` is plaintext (matches the column). It is NEVER logged.
- `phone` / `national_id` are NEVER read, written, logged, or echoed here.
- Audit (best-effort, try/catch) records FIELD NAMES ONLY:
  `afterState: { changed: ['email'] }` — never the email value. Matches
  `owners.service.ts` (`{ changed: [...] }`) + the portal `logout` audit.
- The response re-selects via the SAME masked projection `getMe` uses, so
  national_id/phone stay masked (`•••••••XX` / `•••••XXXX`) on the wire.

## Surface

- `PATCH /api/v1/portal/me` under the existing `TenantAuthGuard`,
  `ZodValidationPipe(PortalUpdateContactSchema)`, `@Throttle` 10 / 10min.
- shared-types: `PortalUpdateContactSchema` + `PortalUpdateContactDto`.
- FE: inline Edit affordance on the EMAIL row only; phone stays read-only.
