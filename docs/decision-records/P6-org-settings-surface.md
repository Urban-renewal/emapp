# P6 slice 1 — per-org settings read/write surface (risk: medium, security-reviewed)

**Decision.** Expose the OrgSettings seam (the `organizations.settings` JSONB the
notifications engine already reads) through a manager/admin read+write API + a
settings UI, closing the configurable-architecture loop end-to-end.

**Persistence — NOT Gate-6.** `organizations.settings` (jsonb, `.notNull().default({})`)
already exists (`packages/db/src/schema/tenancy.ts`). No migration; no RLS/role change.

**Endpoints.**

- `GET /api/v1/org/settings` (permission `org.settings.read`) → `{ data: resolveOrgSettings(stored) }`
  (always fully resolved: defaults + per-org overrides).
- `PATCH /api/v1/org/settings` (permission `org.settings.update`) → validates the body with
  `OrgSettingsPatchSchema`, deep-merges per-namespace over the STORED raw jsonb, persists via
  `withTenant(orgId)`, audits `{changed:[namespace names]}` (NAMES only, no values), re-resolves.

**Authz tier — Admin/Owner, NOT the D.17 Manager (documented divergence).** The IAM catalog
holds `org.settings.read`/`org.settings.update`; the D.17 **Manager** role is `ALL_OPERATIONAL`,
which deliberately EXCLUDES the `org.*` prefix. So org-config write is an **Owner/Admin** action,
not an operational-Manager one. This is the correct posture (org-wide policy is a higher privilege
than per-project operational work) and was honored WITHOUT a Gate-2 IAM change — we wired against
the existing enforced permission, did not grant Manager `org.*`. Viewer/Agent/Manager-without-grant → 403.

**Patch schema is a TRUE partial (fixes a security-review MED).** `OrgSettingsPatchSchema` is
derived from the read schema's shape with each leaf's `.default()` STRIPPED and each namespace
`.strict()`. This prevents (a) default-injection clobber — a one-leaf patch no longer resets the
namespace's other leaves to defaults (silent data loss) — and (b) stray-leaf acceptance — a typo'd
leaf is now a 400, not silently stripped. Value bounds are preserved; the read/patch schemas share
one field-definition source so they cannot drift.

**TIGHTEN-ONLY seam (empty today, enforced).** The modeled namespaces (notifications, messaging,
branding, locale, timezone, signatures, consent, limits) are all FREE preferences. Security floors
(OTP/lockout/throttle/token-TTL) are DELIBERATELY excluded from this seam and stay locked elsewhere.
An `assertTightenOnly` guard runs before persist with an empty registry — ready for the day a floored
knob is added, so a future per-org override can only tighten, never loosen a locked floor.

**Verification.** builder ≠ test-author (21 real-DB tests: authz, no-clobber, cross-org isolation,
audit-no-PII, bounds, stray-leaf→400, no-default-injection — the load-bearing ones mutation-proven)
≠ security-review (PASS; found the MED clobber, now fixed) ≠ manager verify. FE: a notifications-config
section (channel toggles) over GET/PATCH. No migration; not Gate-6.
