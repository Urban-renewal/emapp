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
