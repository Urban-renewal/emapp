# DESIGN — Configurable form-builder (Epic F)

> Status: **DESIGN — awaiting owner sign-off. NOTHING is built.** 2026-06-10.
> Per the owner's vision: "a default form we built; allow an area in the UI to create
> forms, and let an org define the fields it wants — for modularity + genericity."
> This doc is the proposal to decide BEFORE any build. Do NOT implement before sign-off.

## 1. The vision (owner's words, paraphrased)

The project create-form is currently fixed in code. The owner wants:

- The form we built to be the **DEFAULT** template.
- An **area in the UI** where an org can **create its own forms** OR **define which
  fields it wants** — so each org can tailor intake to its own process.
- Generic + modular, single-source-of-truth, no "mess."

## 2. What already exists (build ON this, don't duplicate)

- The project create-form (`apps/web/.../projects/new/page.tsx`) — the default form.
- P3 (PR #340) already added the renewal fields (developer/parcel/relocation/…) as
  fixed columns. **Epic F generalizes this**: instead of adding each new field as a
  migration, an org defines fields itself.
- The org-settings seam (`OrgSettings`, per-namespace, fail-soft) — a precedent for
  per-org configuration.
- The IAM engine (custom roles / overrides) — precedent for org-defined, generic,
  DB-backed configuration that the app resolves at runtime.

## 3. The core modeling decision (the fork the owner must weigh)

A form-builder is **EAV (entity-attribute-value)** at heart — and EAV is powerful but
notoriously easy to do badly. Two architectures:

### Option A — "Custom fields on a fixed entity" (RECOMMENDED for MVP)

Keep `projects` (and other core entities) as typed tables. Add a generic
**`custom_field_definitions`** (org-scoped: key, label, field_type, required,
validation, options, target_entity, display_order, archived) + a
**`custom_field_values`** (entity_id, field_def_id, value jsonb) — OR a single
`custom_data jsonb` column per entity validated against the org's field-defs.

- ✅ The core domain (projects/owners/signatures) stays strongly typed + queryable +
  RLS-safe; only the _extra_ fields are dynamic.
- ✅ Incremental: ships as "add custom fields to the project form" first.
- ✅ Generic engine: one field-def schema + one dynamic renderer + one validator.
- ⚠️ Custom-field values are less queryable/reportable than real columns (acceptable
  — they're org-specific extras, surfaced in detail + export).

### Option B — "Fully dynamic forms" (defer / post-MVP)

Arbitrary org-defined forms + submissions (form_definitions, form_fields,
form_submissions) decoupled from the core entities.

- ✅ Maximum flexibility (intake forms, surveys, anything).
- ❌ Heavy: a whole forms subsystem, its own permissions, validation, versioning,
  reporting; high risk of the "EAV mess" the owner wants to avoid; large surface.
- **Recommendation: NOT now.** Option A delivers the owner's stated need (org defines
  the fields it wants on the project form) at a fraction of the risk. Option B is a
  later epic if a true standalone-forms product is needed.

**My recommendation: Option A**, scoped first to the project create-form, built as a
generic engine reusable for other entities later.

## 4. Proposed architecture (Option A, SOLID/generic) — for sign-off

1. **Field-definition catalog (org-scoped, versioned, Gate-6 migration):**
   `custom_field_definitions(org_id, target_entity, key, label_i18n, field_type
[text|number|date|select|multiselect|boolean], required, validation jsonb,
options jsonb, display_order, archived_at)`. FORCE RLS tenant_isolation. Versioned
   so a value records the def-version it was captured against (immutability, like the
   consent notice_hash).
2. **Values:** a `custom_data jsonb` column on the target entity (e.g. `projects`),
   validated server-side against the org's active field-defs (a generic validator:
   Zod built dynamically from the field-defs). One column, RLS rides the entity, no
   EAV join explosion.
3. **A management UI** (Settings → "Custom fields", gated `org.settings` / a new
   `forms.manage` permission via the IAM engine): the org adds/edits/orders/archives
   fields per entity — the "area to define the fields it wants."
4. **A generic dynamic renderer** (FE): given the org's field-defs, render the inputs
   in the create/edit form + show them on detail + include in export. One renderer,
   data-driven — the modularity the owner asked for.
5. **The default form** = the built-in fixed fields (name/type/… + P3 fields); the
   custom fields are additive on top. The org never loses the default; it extends it.

## 5. Cross-cutting concerns to decide

- **Permissions:** who manages field-defs? Recommend a new `forms.manage` permission
  (Owner/Admin), resolved by the existing IAM engine — reuses P2.
- **Validation:** server-authoritative (build a Zod schema from the field-defs at
  request time; never trust the client). Bounded field count + value sizes (DoS).
- **PII:** a custom field COULD capture PII (an org adds "tenant ID number"). Decision
  needed: do custom fields support a `pii: true` flag → pgcrypto-encrypted + masked +
  audited like national_id? Recommend YES (mark-as-PII → encrypted-at-rest), or
  explicitly forbid PII in custom fields (simpler, but limiting). **Owner decision.**
- **Export/conformance:** custom fields flow into the export + the api-docs generator.
- **i18n:** labels are org-authored free text (bidi-stripped), not platform i18n keys.

## 6. Phasing (if approved)

- **F.1** field-def catalog + `custom_data` on `projects` + the validator engine
  (Gate-6 migration) — backend.
- **F.2** the management UI (define fields) + the dynamic renderer on the project form.
- **F.3** detail + export integration.
- **F.4** (optional) extend the same engine to owners/other entities.
- **F.B (later epic)** Option B standalone forms — only if a real forms product is needed.

## 7. Decisions required from the owner (the sign-off gate)

1. **Option A (custom fields on fixed entities) vs Option B (standalone forms)** —
   recommend A.
2. **PII in custom fields:** support an encrypted "PII field" type, or forbid PII in
   custom fields? — recommend support-with-encryption.
3. **Scope of the first slice:** project form only, or multi-entity from the start? —
   recommend project-only first.
4. **Permission:** new `forms.manage` (Owner/Admin) — confirm.

**Until the owner signs off on §7, no Epic-F code is written.** This is the agreed
gate (Epic F = DESIGN FIRST + owner sign-off).
