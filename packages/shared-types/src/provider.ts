/**
 * D.37 / Phase 6.5 — Provider Admin BE wire contracts.
 *
 * All endpoints under `/api/v1/provider/*` are READ-ONLY (Gate-6 gates
 * any write). Every endpoint requires the `access_reason` HTTP header;
 * missing → 400 `reason_required`. Every endpoint writes a
 * `provider_audit_log` row via `withProvider(uid, reason, fn, { action })`.
 *
 * PII rule (also at Provider tier — D.37 + D.19):
 *   - Owner name → masked to first/last char-window pattern (•••••••XX)
 *   - Owner phone → masked (•••••XXXX, last 4)
 *   - national_id → NEVER returned on the wire (no unmask flag in MVP)
 *
 * Tier isolation (D.29): these endpoints accept ONLY the provider JWT
 *   (audience=`emapp-provider`, type=`provider_access`,
 *   role=`provider_admin`). Org-tier JWT MUST 401 via ProviderAuthGuard.
 */
import { z } from 'zod';

// ───────────────────────────────────────────────────────────────────
// Cursor pagination — uses the same envelope as the rest of the API.
// ───────────────────────────────────────────────────────────────────
export const ListTenantsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListTenantsQuery = z.infer<typeof ListTenantsQuerySchema>;

// ───────────────────────────────────────────────────────────────────
// GET /provider/tenants — list orgs.
// No PII at the list level — just org-level metadata + counts so the
// Provider Admin can pick a tenant to drill into.
// ───────────────────────────────────────────────────────────────────
export const TenantListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
  /** Non-null ⇒ the org is FROZEN (suspended, D.49) — distinct from archivedAt
   *  soft-delete. Surfaced in the list so an operator can see frozen orgs while
   *  scanning, without opening each detail view. */
  suspendedAt: z.coerce.date().nullable(),
  /** Aggregated counts for the dashboard view. */
  counts: z.object({
    users: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative(),
    owners: z.number().int().nonnegative(),
  }),
});
export type TenantListItem = z.infer<typeof TenantListItemSchema>;

// ───────────────────────────────────────────────────────────────────
// GET /provider/tenants/:id — tenant detail.
// Includes sample owners (PII masked in-SQL via pgcrypto + masking
// helpers — same pattern as the org-tier NID_MASK / PHONE_MASK).
// ───────────────────────────────────────────────────────────────────
export const TenantSampleOwnerSchema = z.object({
  id: z.string().uuid(),
  /** Masked: pattern `•••••••XX` — first 7 bullets, last 2 chars. */
  nameMasked: z.string(),
  email: z.string().nullable(),
  /** Masked: pattern `•••••XXXX` — last 4 digits; null if no phone. */
  phoneMasked: z.string().nullable(),
  archivedAt: z.coerce.date().nullable(),
});
export type TenantSampleOwner = z.infer<typeof TenantSampleOwnerSchema>;

export const TenantDetailSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
  /**
   * D.49 — operational suspension state, surfaced so the console can
   * render the correct write action (suspend vs reactivate) on load and
   * show a suspended banner. `suspendedAt` non-null ⇒ the org is frozen
   * (distinct from `archivedAt` soft-delete). `suspendedReason` is the
   * operator note captured at suspend time. Read-only projection of the
   * same columns the suspend/reactivate writes mutate — no new authority.
   */
  suspendedAt: z.coerce.date().nullable(),
  suspendedReason: z.string().nullable(),
  counts: z.object({
    users: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative(),
    owners: z.number().int().nonnegative(),
    importJobs: z.number().int().nonnegative(),
    signatureRequests: z.number().int().nonnegative(),
  }),
  /** Up to 5 most-recently-created owners — masked PII only. */
  sampleOwners: z.array(TenantSampleOwnerSchema).max(5),
});
export type TenantDetail = z.infer<typeof TenantDetailSchema>;

// ───────────────────────────────────────────────────────────────────
// D.49 — Provider WRITE actions (supersedes the D.37 read-only lock).
//
// POST /provider/tenants/:id/suspend     — freeze an org operationally.
// POST /provider/tenants/:id/reactivate  — lift the suspension.
//
// Both go through the audit-first `withProvider` path with a distinct
// `write` ProviderAction (policy.ts, Gate-6 D.49) and the mandatory
// `access_reason` header (the forensic reason; stored in
// provider_audit_log). The optional body `note` is the operator-facing
// reason persisted on the org (`organizations.suspended_reason`) and
// shown in the console — distinct from the forensic access_reason.
//
// Destructive/irreversible actions (purge) are deliberately ABSENT —
// out of scope per D.49 until a separate decision.
// ───────────────────────────────────────────────────────────────────
export const SuspendTenantBodySchema = z
  .object({
    /** Operator-facing note → persisted to `organizations.suspended_reason`. */
    note: z.string().trim().min(1).max(500).optional(),
  })
  // `.strict()` — every body schema rejects unknown keys (the invariant the
  // ZodValidationPipe's fail-closed depth scan relies on). A caller cannot
  // smuggle extra fields past validation.
  .strict();
export type SuspendTenantBody = z.infer<typeof SuspendTenantBodySchema>;

export const TenantSuspensionStateSchema = z.object({
  id: z.string().uuid(),
  /** True after suspend, false after reactivate. */
  suspended: z.boolean(),
  /** ISO timestamp the org was suspended; null when active. */
  suspendedAt: z.coerce.date().nullable(),
  /** Operator note captured at suspend time; null when active. */
  suspendedReason: z.string().nullable(),
});
export type TenantSuspensionState = z.infer<typeof TenantSuspensionStateSchema>;

// ───────────────────────────────────────────────────────────────────
// D.45 — Provider-initiated onboarding: create an Org + invite the
// first Manager (invite-token email; the manager sets their own
// password). POST /provider/tenants. Audited via the audit-first
// `withProvider` path with a distinct `provider.tenant.created` action
// (the existing `write` ProviderAction — no new policy cell, D.49).
//
// `orgName` / `managerName` are free-form (escaped at the email layer);
// `managerEmail` is normalised lower-case. The org slug is ALWAYS
// server-generated (random suffix) — never client-supplied — so it is
// absent from the request body.
// ───────────────────────────────────────────────────────────────────
export const OnboardOrgBodySchema = z
  .object({
    orgName: z.string().trim().min(2).max(120),
    managerName: z.string().trim().min(1).max(120),
    // Normalise to lower-case so the citext unique index + any later
    // lookup are consistent; max 254 per RFC 5321.
    managerEmail: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();
export type OnboardOrgBody = z.infer<typeof OnboardOrgBodySchema>;

export const OnboardOrgResultSchema = z.object({
  orgId: z.string().uuid(),
  /** Server-generated, URL-safe slug. */
  slug: z.string(),
  orgName: z.string(),
  /** Echoed back so the console can show "invite sent to …". */
  managerEmail: z.string().email(),
  /** Present ONLY outside production (D.27 — EXPOSE_INVITE_TOKEN). The
   *  console shows it once; in prod the email is the sole delivery path
   *  and this is absent. Never persisted. */
  inviteToken: z.string().optional(),
});
export type OnboardOrgResult = z.infer<typeof OnboardOrgResultSchema>;

// ───────────────────────────────────────────────────────────────────
// GET /provider/audit — cross-tenant audit search.
// Filters: org_id (optional, repeatable in query), action prefix, date
// range. Cursor-paginated.
// ───────────────────────────────────────────────────────────────────
/**
 * **Audit v1.1 SA-4 (HIGH, ISO A.12.1.3) closure** — bound the
 * cross-tenant audit search.
 *
 * Pre-closure the query accepted ANY combination of filters,
 * including "no filters at all". With `idx_audit_org_time` keyed
 * `(org_id, created_at desc)`, the absence of an `orgId` predicate
 * degenerated to a sequential scan of `audit_log` across every
 * tenant. Limit=100 capped the rows RETURNED but not the rows
 * SCANNED — at 30M rows + 60s `statement_timeout`, a Provider Admin
 * (or a compromised account) could pin a Provider-pool slot for the
 * full minute with a single unfiltered request.
 *
 * Rule: at least ONE of these must hold:
 *   - `orgId` set (planner uses the per-org index), OR
 *   - `fromDate` set AND `(toDate ?? now) - fromDate <= 31 days`
 *     (planner uses the new CC-6 `(action text_pattern_ops,
 *     created_at DESC)` index when `action` is also set; otherwise
 *     uses the `created_at DESC, id DESC` keyset bounded by date).
 *
 * 31 days is the bookkeeping period most ops investigations need;
 * widening requires `orgId`. Auditors who need a longer window can
 * paginate via cursor across multiple 31-day chunks.
 */
const PROVIDER_AUDIT_MAX_DATE_SPAN_MS = 31 * 24 * 60 * 60 * 1000;

export const ProviderAuditQuerySchema = z
  .object({
    orgId: z.string().uuid().optional(),
    action: z
      .string()
      .min(1)
      .max(128)
      // Action filter is a PREFIX match (e.g. `import.` matches all import.* actions).
      // Restrict to the same shape the audit writer emits to avoid surprise patterns.
      .regex(/^[a-z][a-z0-9_.-]*$/i, 'action must be a dot-separated identifier prefix')
      .optional(),
    /** ISO timestamp inclusive lower bound. */
    fromDate: z.coerce.date().optional(),
    /** ISO timestamp inclusive upper bound. */
    toDate: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).optional(),
  })
  .refine((q) => !(q.fromDate && q.toDate) || q.fromDate <= q.toDate, 'fromDate must be <= toDate')
  .refine(
    (q) => {
      if (q.orgId) return true;
      // No orgId → require fromDate AND a bounded span.
      if (!q.fromDate) return false;
      const upper = q.toDate ?? new Date();
      const spanMs = upper.getTime() - q.fromDate.getTime();
      return spanMs >= 0 && spanMs <= PROVIDER_AUDIT_MAX_DATE_SPAN_MS;
    },
    {
      message:
        'audit search must filter by orgId, OR set fromDate with a date span <= 31 days (Audit v1.1 SA-4)',
    },
  );
export type ProviderAuditQuery = z.infer<typeof ProviderAuditQuerySchema>;

export const ProviderAuditItemSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  actorType: z.enum(['user', 'system', 'provider']),
  action: z.string(),
  targetTable: z.string().nullable(),
  targetId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
});
export type ProviderAuditItem = z.infer<typeof ProviderAuditItemSchema>;

// ───────────────────────────────────────────────────────────────────
// GET /provider/system-health — read-only gauges.
// Numbers only — no per-row data, no PII surface possible.
// ───────────────────────────────────────────────────────────────────
export const SystemHealthSchema = z.object({
  queue: z.object({
    /** pg-boss jobs currently in `active` state across all queues. */
    active: z.number().int().nonnegative(),
    /** Created + not yet picked up. */
    created: z.number().int().nonnegative(),
    /** Retrying (failed + scheduled for retry). */
    retry: z.number().int().nonnegative(),
    /** Failed permanently (retry budget exhausted). */
    failed: z.number().int().nonnegative(),
    /** Completed (rolling window — pg-boss keeps these per `archive` settings). */
    completed: z.number().int().nonnegative(),
  }),
  pool: z.object({
    app: z.object({
      total: z.number().int().nonnegative(),
      idle: z.number().int().nonnegative(),
      waiting: z.number().int().nonnegative(),
    }),
    provider: z.object({
      total: z.number().int().nonnegative(),
      idle: z.number().int().nonnegative(),
      waiting: z.number().int().nonnegative(),
    }),
  }),
  r2: z.object({
    /** Errors observed since the most recent process start. */
    errorsSinceBoot: z.number().int().nonnegative(),
    /** ISO timestamp of the last observed error; null if none. */
    lastErrorAt: z.coerce.date().nullable(),
  }),
  timestamp: z.coerce.date(),
});
export type SystemHealth = z.infer<typeof SystemHealthSchema>;
