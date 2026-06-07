# Architecture — per-org configurable policy (the generic spine)

**The owner's directive (foundational):** EMAPP is multi-tenant. Every cross-cutting
POLICY — who receives which notification, what an agent may do, which channels, which
thresholds — must be **per-org CONFIGURABLE**: shipped with a sensible **DEFAULT**,
**OVERRIDABLE by the org manager**. Build it **policy-as-DATA, not policy-as-code**, so
adding or changing a policy is a config row + a generic engine — never a code change
that "shakes" the system (SOLID open/closed). This is the spine; notifications,
permissions, and future policies are instances of it — do NOT route/gate ad-hoc per
feature.

## The pattern (apply to EVERY cross-cutting policy)

1. **Config store** — a per-org table (rows), seeded from a shipped DEFAULT.
2. **Generic engine** — ONE function/service per policy domain that READS the config and
   applies it, falling back to the default when the org hasn't customized.
3. **Manager UI** — a settings surface to view/override. Exposed **incrementally**: the
   engine + default ship first; the edit-UI grows in. The SEAM is generic from day one
   even if the UI only shows the default at first.

> Balance (do NOT over-engineer for MVP): build the SEAM generic (config-driven engine +
> default), ship the default behavior, expose the customization UI incrementally. The
> point is that later customization is a config + UI addition, never an engine rewrite.

## Instance 1 — Notifications

- **Config:** `notification_settings` per org — for each event-type (document_uploaded,
  apartment_status_changed, note_added, share_revoked, import_completed, …): the
  recipient rule (which roles/scopes) + the channels (in-app / email / SMS).
- **Default (D-O7):** managers ALWAYS + project-assigned (for project events) / relevant
  users (for entity events) − actor. This is now THE DEFAULT, not a hardcode.
- **Engine:** `resolveNotificationRecipients(tx, orgId, ctx)` reads the org's settings,
  falls back to the D-O7 default. Channel dispatch (in-app now; email/SMS later) reads the
  same config. EVERY emit site calls the engine — no per-type recipient code.
- **UI:** the settings page already has a stubbed **"notifications" tab**
  (`settings.notifications`) — that's where the per-org override lands.

## Instance 2 — Permissions

- **LOCKED, do NOT make configurable:** the 6 roles / 3 tiers (D.17, D.20) and the engine
  permission catalog. The role SET is the contract; an org does not invent roles in MVP.
- **The per-org flexibility IS the agent CAPABILITY layer** (already built): the manager
  grants each agent the 7 capabilities via members → capabilities. That is the
  "manager configures permissions for his org" surface, and B-AGENT-1 made it actually
  take effect.
- **Generic extensions (incremental, SOLID-compatible):**
  - per-org capability PRESETS / templates ("field agent", "office agent") — config rows
    the manager picks from, applied via the SAME capability mechanism.
  - per-PROJECT capability overrides (catalog #8) — capabilities on `project_assignments`
    instead of only `memberships`; the effective-permission resolver already centralizes
    the read, so this extends the data source, not the engine.
  - These extend the existing capability seam; they do NOT touch the locked role set or
    re-introduce the split-brain (the `agent-effective-permissions` map + drift guard stay
    the single source of truth).

## Instance 3 — Thresholds / other policies (already partly here)

- The consent threshold (Feature B) is already per-project-overridable with a per-TYPE
  default map — the SAME pattern (default + override). Keep new policies consistent with
  it.

## SOLID guarantees this buys

- **Open/closed:** a new event-type, channel, or capability preset = a config entry the
  generic engine already handles. No new branching code per case.
- **Single source of truth:** one engine per domain (notifications, effective-permissions),
  config-driven. No policy duplicated across call sites.
- **Multi-tenant by construction:** defaults shipped; each org overrides its own rows;
  nothing about one org is hardcoded into another's behavior.

## What this means for the fresh session (concrete)

1. Build the notification ENGINE config-driven: a `notification_settings` table (per org,
   per event-type) + `resolveNotificationRecipients` reading it with the D-O7 default.
   Ship the default behavior; the settings UI is a follow-up. Retrofit document_uploaded
   (#274) onto the engine.
2. Keep the capability layer as the per-org permission config; design presets / per-project
   caps as data extensions of it (do not fork the resolver).
3. For ANY new cross-cutting behavior, ask first: "is this a per-org policy?" If yes →
   default + config + generic engine, never a hardcode.

---

# The complete policy-domain map (grounded code sweep, 2026-06-07)

## The config store ALREADY EXISTS — no migration to start

`organizations.settings` is a `jsonb NOT NULL DEFAULT '{}'` column
(`packages/db/src/schema/tenancy.ts:24`) that is **currently UNUSED**. It is the home for
per-org config — add namespaced keys (`settings.notifications`, `settings.messaging`,
`settings.locale`, …) with NO schema migration. The **settings PAGE shell also exists**
(`apps/web/.../settings`, 5 tabs: general[wired] / team / notifications[stub] /
integrations[stub] / security[stub]) — the override UI has a home too. Build a typed
`OrgSettings` Zod schema (defaults baked in) + a `getOrgSettings(tx, orgId)` resolver that
parses `organizations.settings` over the defaults. That ONE resolver feeds every domain.

## ⚠️ SECURITY FLOOR — a non-negotiable caveat on "configurable"

Some policies are SECURITY controls. "Per-org configurable" must mean **the org may make
them STRICTER, never weaker than the secure default** — the shipped default is a FLOOR, and
a few are fully LOCKED. Otherwise a compromised manager (or a careless one) could weaken the
org's own security. Specifically:

- **LOCKED (never per-org):** access-token TTL (org 15m / provider 30m / tenant 10m — the
  tenant 10m is a stolen-phone hedge), refresh-token TTLs, the argon2-bound signup/login
  throttles. Loosening these is a vuln.
- **Tighten-only (floor = the secure default):** OTP attempts (5) / lockout (15m) / rate
  limit (3 per 15m); failed-login lockout (5 / 15m); the read/write throttles. An org may
  set them STRICTER; the engine clamps any value to ≤ the secure default.

## The map

### A. SPINE INSTANCES to build (config-driven, default = current behavior)

| Domain                                                                                                                                                    | Today (file:line)                                                                                                                             | Config key                                                      | Default                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------ |
| **Notification routing + channels**                                                                                                                       | hardcoded per emit                                                                                                                            | `settings.notifications[event]` → recipients + channels         | D-O7 (managers always + scope) |
| **Outbound message templates** (11 of them: signature invite email/SMS/WhatsApp, signed-confirm, manager-notify, member invite, OTP SMS, calendar emails) | hardcoded Hebrew strings in `signature-link-delivery.ts:82-205`, `otp.service.ts:137`, `members/invite-email.ts`, `calendar-email.service.ts` | `settings.messaging[template]` (subject/body, with `{{vars}}`)  | the current Hebrew copy        |
| **Sender identity**                                                                                                                                       | global "EMAPP" name + one SMS sender/email-from                                                                                               | `settings.branding.senderName` / per-org email-from             | "EMAPP" / env sender           |
| **Locale + timezone**                                                                                                                                     | `'he'` (`i18n/routing.ts:5`), `Asia/Jerusalem` (5+ format sites)                                                                              | `settings.locale`, `settings.timezone`                          | he / Asia/Jerusalem            |
| **Signature link TTL**                                                                                                                                    | `7d` (`signature-token.service.ts:36`)                                                                                                        | `settings.signatures.linkTtlDays`                               | 7                              |
| **Signature delivery channels** (D-O2)                                                                                                                    | "SMS-if-phone + email-if-email + WhatsApp" (`signature-link-delivery.ts:233-264`)                                                             | `settings.signatures.channels` (which + order)                  | all available                  |
| **Per-type consent default**                                                                                                                              | global `PROJECT_TYPE_DEFAULT_CONSENT_PCT`                                                                                                     | `settings.consent[type]` (org default; project still overrides) | 66/80/80                       |
| **Bulk cap / list page-size default**                                                                                                                     | bulk 200, default limit 25                                                                                                                    | `settings.limits.*`                                             | 200 / 25                       |

### B. INCREMENTAL extensions (same pattern, post-default)

- **Agent capability PRESETS** ("field agent"/"office agent") → `settings.capabilityPresets` →
  applied via the EXISTING per-agent capability mechanism (do not fork the resolver).
- **Per-PROJECT capability overrides** (catalog #8) → capabilities on `project_assignments`;
  the `agent-effective-permissions` resolver extends its data source, not its logic.
- **Per-org DEFAULT share template** → `settings.shareDefaults` (the new-share baseline the
  manager sets; `share-defaults.ts` consults it first).
- **Custom task TYPES** — already free-text (`task.ts:19`); add an org preset list (UI guidance).
- **Apartment-status / project-status AUTOMATION** (on-transition actions) — future per-org
  rules engine; the ENUMS stay locked.
- **Document custom CATEGORIES** — map org labels → the canonical doc-type enum (future).
- **Reminder cadence** for unsigned owners — NOT built yet; when added, a per-org policy.
- **Branding (logo/colors)** — post-MVP; UI colors are global today (fine for MVP).

### C. LOCKED — never per-org (the crisp boundary)

The 6 roles / 3 tiers (D.17, D.20) · project status enum (D.18) · project type enum (D.18) ·
apartment status enum · task status + priority · the notification EVENT vocabulary (the
types; only their routing is configurable) · the share-permission SCHEMA shape (D.46; only
its defaults are configurable) · PII pgcrypto encryption + the `national_id` field model
(D.19) · RLS (`withTenant`/`withProvider`) · the ownership sum=100 trigger (D.25) · the
`{data}` envelope (D.16) · the `/api/v1` prefix (D.10) · the security-locked token TTLs.
When genericness would touch any of these, it STOPS at the contract edge.

## Build priority (phased — do NOT build it all at once)

1. **Foundation:** the `OrgSettings` schema + `getOrgSettings` resolver over
   `organizations.settings` (no migration). One typed seam everything reads.
2. **First instance:** notifications (the engine + D-O7 default) — already the next task.
3. **High-value, low-risk:** messaging templates + sender name + locale/timezone (these are
   the classic "make it ours" knobs; all read the same settings resolver).
4. **Incremental:** the §B extensions, each as data + the existing engine, exposed via the
   settings tabs as they mature.
   The DEFAULT behavior is unchanged at every step; customization is additive. That is the
   guarantee that "later changes don't shake the system."
