import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// Per-org configurable policy — the typed seam (P1-1 foundation).
//
// `organizations.settings` (jsonb NOT NULL DEFAULT '{}') is the per-org config
// home (no migration). THIS schema is the single source of truth for its shape
// + defaults; the `getOrgSettings(tx, orgId)` resolver in @emapp/api parses the
// stored jsonb OVER these defaults. Every future per-org policy domain
// (notification routing, messaging templates, sender identity, locale/timezone,
// signature TTL/channels, consent thresholds, list/bulk limits) reads from
// here — never an ad-hoc per-feature config.
//
// See docs/ARCHITECTURE-per-org-configurable-policy.md (the spine). Defaults
// MUST reflect TODAY's behavior so shipping this seam changes nothing until an
// org actually overrides a key.
//
// DESIGN — fail-soft PER NAMESPACE: every namespace is `.default({})` (absent →
// its default) AND `.catch(() => <its default>)` (malformed → its default), and
// every leaf has a baked default, so a partial / malformed / null stored value
// degrades to defaults (a bad config row must NEVER 500 a read). Fallback is
// per-namespace, NOT whole-tree: a malformed namespace reverts only itself while
// valid sibling namespaces in the same object survive. The resolver deep-merges
// by virtue of Zod parsing per-namespace defaults. Pure Zod, no @emapp/* imports
// (FE-safe, no circular deps).
//
// SECURITY FLOOR (spine §"SECURITY FLOOR"): OTP/lockout/throttle and token
// TTLs are NOT modeled here — they are LOCKED or tighten-only and enforced in
// Phase 6, not via this open settings seam. Keeping them out keeps the
// "configurable" surface free of security controls a careless manager could
// weaken.
// ─────────────────────────────────────────────────────────────────────────

/** Notification delivery channels (in-app shipped; email/SMS land later). */
export const NotificationChannelEnum = z.enum(['in_app', 'email', 'sms']);
export type NotificationChannel = z.infer<typeof NotificationChannelEnum>;

/**
 * Notifications namespace. The routing RULE (which recipients) is the D-O7
 * default applied by the engine and is intentionally NOT modeled as free data
 * here yet — only the cross-cutting channel default lives in config at this
 * foundation step. Per-event-type overrides (`settings.notifications[event]`)
 * are added incrementally by the notifications instance without changing this
 * seam (open/closed).
 */
export const NotificationSettingsSchema = z
  .object({
    /** Default channels every notification fans out to. In-app is the shipped
     *  baseline; email/SMS dispatch reads the same config when wired. */
    defaultChannels: z.array(NotificationChannelEnum).default(['in_app']),
  })
  .default({});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

/**
 * Messaging templates namespace. Today the 11 outbound templates are hardcoded
 * Hebrew strings at their emit sites; the override map lands here
 * (`settings.messaging[template] = { subject?, body }` with `{{vars}}`). Empty
 * default = "use the shipped Hebrew copy" (the emit site keeps its constant
 * when no override is present). Bounded record so a malformed blob can't bomb.
 */
export const MessageTemplateSchema = z
  .object({
    subject: z.string().max(300).optional(),
    body: z.string().max(5000),
  })
  .strict();
export type MessageTemplate = z.infer<typeof MessageTemplateSchema>;

export const MessagingSettingsSchema = z
  .object({
    /** template-key → override. Absent key → the hardcoded default copy. */
    templates: z.record(z.string(), MessageTemplateSchema).default({}),
  })
  .default({});
export type MessagingSettings = z.infer<typeof MessagingSettingsSchema>;

/**
 * Sender identity namespace. `senderName` is the org-facing display name on
 * outbound messages (default "EMAPP"). `emailFrom` per-org from-address is
 * optional — absent → the env-configured global sender.
 */
export const BrandingSettingsSchema = z
  .object({
    senderName: z.string().min(1).max(120).default('EMAPP'),
    emailFrom: z.string().email().optional(),
  })
  .default({});
export type BrandingSettings = z.infer<typeof BrandingSettingsSchema>;

/** Signature link delivery channels (D-O2). Order = preference order. */
export const SignatureChannelEnum = z.enum(['sms', 'email', 'whatsapp']);
export type SignatureChannel = z.infer<typeof SignatureChannelEnum>;

/**
 * Signatures namespace. `linkTtlDays` = how long a signature link stays valid
 * (today hardcoded 7d). `channels` = which delivery channels + their order
 * (today "all available": SMS-if-phone + email-if-email + WhatsApp).
 */
export const SignatureSettingsSchema = z
  .object({
    linkTtlDays: z.number().int().min(1).max(90).default(7),
    channels: z.array(SignatureChannelEnum).default(['sms', 'email', 'whatsapp']),
  })
  .default({});
export type SignatureSettings = z.infer<typeof SignatureSettingsSchema>;

/**
 * Per-type owner-CONSENT default threshold (%). The org-level default the
 * project create-form seeds from; a project STILL overrides per-project (the
 * project-level override is unchanged). Keys mirror the project-type enum;
 * defaults mirror `PROJECT_TYPE_DEFAULT_CONSENT_PCT` (66/80/80).
 */
export const ConsentSettingsSchema = z
  .object({
    tama38_1: z.number().min(0).max(100).default(66),
    tama38_2: z.number().min(0).max(100).default(80),
    pinui_binui: z.number().min(0).max(100).default(80),
  })
  .default({});
export type ConsentSettings = z.infer<typeof ConsentSettingsSchema>;

/**
 * Operational limits namespace. `bulkCap` = max rows in a bulk action (today
 * 200). `defaultPageSize` = list page-size default (today 25). These are
 * ergonomics knobs, not security controls.
 */
export const LimitsSettingsSchema = z
  .object({
    bulkCap: z.number().int().min(1).max(1000).default(200),
    defaultPageSize: z.number().int().min(1).max(100).default(25),
  })
  .default({});
export type LimitsSettings = z.infer<typeof LimitsSettingsSchema>;

// Base object schema (no `.catch` — referencing the final schema inside its own
// `.catch` would create a self-referential type). The fully-defaulted tree is
// derived from this base, then each namespace gets its own `.catch` (below) so
// a malformed namespace degrades to ITS default while valid siblings survive.
const OrgSettingsObject = z.object({
  notifications: NotificationSettingsSchema,
  messaging: MessagingSettingsSchema,
  branding: BrandingSettingsSchema,
  locale: z.enum(['he', 'en', 'ar']).default('he'),
  timezone: z.string().min(1).default('Asia/Jerusalem'),
  signatures: SignatureSettingsSchema,
  consent: ConsentSettingsSchema,
  limits: LimitsSettingsSchema,
});

/** The fully-defaulted settings tree (today's behavior). Handy for tests and
 *  any caller needing the baseline without a DB read. */
export const DEFAULT_ORG_SETTINGS: OrgSettings = OrgSettingsObject.parse({});

/**
 * THE per-org settings contract. Every namespace is `.default({})` so a fully
 * empty `{}` (the column default) parses to the complete default tree, and a
 * partial override (e.g. only `locale`) still yields every other default —
 * deep-merge-by-defaults. Each top-level NAMESPACE additionally carries its own
 * `.catch(() => <that namespace's default>)`, so a malformed namespace (e.g.
 * `signatures.linkTtlDays:"abc"`) degrades to ITS default while valid sibling
 * namespaces in the same object (e.g. `locale:'en'`) are PRESERVED — fail-soft
 * per-namespace, not whole-tree. The outermost `.catch` is belt-and-suspenders
 * for a top-level non-object (null, array, scalar). Granularity is per-namespace
 * by design: a bad leaf reverts its whole namespace, not just that leaf. Single
 * `.parse` per read; no per-key re-parsing. (The `messaging.templates`
 * `z.record` replaces the override map WHOLESALE on a malformed blob — it is not
 * merged per-entry.)
 */
export const OrgSettingsSchema = z
  .object({
    notifications: NotificationSettingsSchema.catch(() => DEFAULT_ORG_SETTINGS.notifications),
    messaging: MessagingSettingsSchema.catch(() => DEFAULT_ORG_SETTINGS.messaging),
    branding: BrandingSettingsSchema.catch(() => DEFAULT_ORG_SETTINGS.branding),
    locale: z
      .enum(['he', 'en', 'ar'])
      .default('he')
      .catch(() => DEFAULT_ORG_SETTINGS.locale),
    timezone: z
      .string()
      .min(1)
      .default('Asia/Jerusalem')
      .catch(() => DEFAULT_ORG_SETTINGS.timezone),
    signatures: SignatureSettingsSchema.catch(() => DEFAULT_ORG_SETTINGS.signatures),
    consent: ConsentSettingsSchema.catch(() => DEFAULT_ORG_SETTINGS.consent),
    limits: LimitsSettingsSchema.catch(() => DEFAULT_ORG_SETTINGS.limits),
  })
  .catch(() => DEFAULT_ORG_SETTINGS);
export type OrgSettings = z.infer<typeof OrgSettingsObject>;

/**
 * THE pure parse/merge function — DB-free, unit-testable in isolation. Parses
 * an arbitrary stored value (the `organizations.settings` jsonb, or anything)
 * OVER the baked defaults and returns a fully-typed `OrgSettings`. Never
 * throws: `safeParse` + the schema's own `.catch`/`.default` chain mean a
 * malformed, partial, or null input degrades to defaults. The DB resolver
 * (`getOrgSettings`) is a thin SELECT wrapper around this.
 *
 * Deep-merge semantics: because each NAMESPACE carries its own `.default({})`
 * and each LEAF its own default, an input that sets only some keys is filled
 * out per-key from the defaults — an org that customized `locale` alone still
 * receives every other default. Each namespace also `.catch`es to its OWN
 * default, so a malformed namespace reverts only itself and valid siblings in
 * the same object survive (`{ locale:'en', signatures:{ linkTtlDays:'abc' } }`
 * keeps `locale:'en'` and reverts `signatures` to its default).
 */
export function resolveOrgSettings(raw: unknown): OrgSettings {
  const parsed = OrgSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_ORG_SETTINGS;
}

// ─────────────────────────────────────────────────────────────────────────
// THE WRITE contract — the PATCH body for `PATCH /api/v1/org/settings`
// (P6-1: the admin write surface for the seam).
//
// A PATCH is a PARTIAL override: a caller sends only the namespaces/leaves it
// wants to change, and the BE deep-merges that over the stored jsonb (so an
// untouched namespace — and untouched LEAVES within a touched namespace — are
// preserved, never clobbered). The patch is a TRUE partial: every leaf is
// `.optional()` WITHOUT a default, so an absent leaf stays ABSENT after parse.
// `{ signatures: { linkTtlDays: 30 } }` parses to EXACTLY
// `{ signatures: { linkTtlDays: 30 } }` (NO `channels` key) — the service merge
// then preserves the org's stored `channels`. `{ notifications: {} }` and `{}`
// are no-ops.
//
// WHY NOT `.deepPartial()`: `.deepPartial()` keeps each leaf's baked `.default`,
// so parsing one leaf would INJECT every sibling leaf's default — the service
// spread `{ ...storedNs, ...patchVal }` would then RESET the unsent siblings to
// their defaults (silent data loss). `.deepPartial()` also rebuilds the nested
// namespace objects WITHOUT `.strict()`, so a stray leaf was silently STRIPPED
// instead of 400'd. Both are fixed by deriving the patch from the read schema's
// field definitions with defaults STRIPPED and `.strict()` reapplied per
// namespace (below).
//
// REJECT UNKNOWN KEYS — every namespace object AND the top level is `.strict()`.
// A typo'd namespace (`{ notificatons: … }`) or a stray leaf
// (`{ branding: { color: … } }`) is a 400, not a silently-stored (or silently-
// stripped) junk key. (The fail-soft READ path tolerates junk for resilience;
// the WRITE path is strict so the stored value stays clean — defense in depth,
// not contradiction.)
//
// VALUE BOUNDS are the SAME sub-schema constraints as the read side — the patch
// is DERIVED from `OrgSettingsObject` (single source of truth, cannot drift):
// `signatures.linkTtlDays` stays int 1..90, `limits.bulkCap` int 1..1000,
// `branding.emailFrom` a valid email, `messaging.templates` values stay strict,
// etc. A PATCH that violates a bound is a 400 — no clamping of an out-of-range
// value into range (that would silently accept a different value than the
// caller sent). The SECURITY-FLOOR tighten-only rule (a loosening clamp) is
// enforced in the BE service, NOT here — see
// `apps/api/.../org-settings.service.ts` `TIGHTEN_ONLY` and the SECURITY FLOOR
// note atop this file (no floored knob is modeled in this seam YET, by design,
// so the registry is wired-but-empty).
//
// No `.catch` anywhere on the patch — we never want a malformed PATCH to
// silently degrade to a default and persist that; a bad write must be a loud
// 400, unlike a bad READ which fails soft.
// ─────────────────────────────────────────────────────────────────────────

/** Peel any chain of `.default(...)` wrappers off a schema, returning the inner
 *  schema with its bounds intact but no default applied. (A leaf wrapped in
 *  `.default(x)` would otherwise INJECT `x` when the key is absent — exactly the
 *  data-loss footgun the patch must avoid.) */
function stripDefault<T extends z.ZodTypeAny>(schema: T): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  while (current instanceof z.ZodDefault) {
    current = current._def.innerType as z.ZodTypeAny;
  }
  return current;
}

/** Derive the PATCH form of one top-level field from its READ definition:
 *  - an OBJECT namespace → each leaf default-stripped + `.optional()`, the whole
 *    namespace `.strict()` (stray leaf → error) and itself `.optional()`;
 *  - a SCALAR namespace (`locale`/`timezone`) → default-stripped + `.optional()`.
 *  Bounds (`.min`/`.max`/`.email`/enum/strict record values) are carried over
 *  verbatim from the read schema — nothing is weakened. */
function toPatchField(field: z.ZodTypeAny): z.ZodTypeAny {
  const inner = stripDefault(field);
  if (inner instanceof z.ZodObject) {
    const patchShape: Record<string, z.ZodTypeAny> = {};
    for (const [leafKey, leafSchema] of Object.entries(inner.shape as z.ZodRawShape)) {
      patchShape[leafKey] = stripDefault(leafSchema).optional();
    }
    return z.object(patchShape).strict().optional();
  }
  return inner.optional();
}

const orgSettingsPatchShape = Object.fromEntries(
  Object.entries(OrgSettingsObject.shape as z.ZodRawShape).map(([key, field]) => [
    key,
    toPatchField(field),
  ]),
) as Record<keyof typeof OrgSettingsObject.shape, z.ZodTypeAny>;

export const OrgSettingsPatchSchema = z.object(orgSettingsPatchShape).strict();

/**
 * The PATCH body TYPE — a TRUE one-level-deep partial of `OrgSettings`: every
 * top-level namespace optional, and within an OBJECT namespace every leaf
 * optional too (so the FE can send `{ signatures: { linkTtlDays } }` without
 * `channels`). Derived from `OrgSettings` itself (not re-inferred from the
 * runtime schema, whose dynamic shape erases precise leaf types) so the FE keeps
 * full leaf-level type-checking AND the type cannot drift from the read shape.
 * Scalar namespaces (`locale`/`timezone`) keep their exact literal/string type.
 */
export type OrgSettingsPatch = {
  [K in keyof OrgSettings]?: OrgSettings[K] extends readonly unknown[]
    ? OrgSettings[K]
    : OrgSettings[K] extends object
      ? Partial<OrgSettings[K]>
      : OrgSettings[K];
};

/** The top-level namespace keys of the settings tree — the audit "changed"
 *  surface (NAMES ONLY; never values). Derived from the base object so it can
 *  never drift from the schema. */
export const ORG_SETTINGS_NAMESPACES = Object.keys(OrgSettingsObject.shape) as Array<
  keyof typeof OrgSettingsObject.shape
>;
export type OrgSettingsNamespace = (typeof ORG_SETTINGS_NAMESPACES)[number];
