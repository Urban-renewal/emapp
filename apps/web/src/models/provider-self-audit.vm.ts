import type { ProviderSelfAuditItem } from '@emapp/shared-types';

/**
 * Provider self-audit ViewModel — B-PROVIDER-2.
 *
 * The operator's OWN action history from `provider_audit_log` (distinct
 * from the cross-tenant `audit_log` search). Each row answers "what did
 * *I* access, when, and with what reason." The VM precomputes:
 *  - `actionCategory` — first segment of `actionType` (open enumeration;
 *    unknown categories fall through to `'other'` so a new BE action never
 *    crashes the FE). Pages apply Hebrew/EN labels via i18n.
 *  - `startedAtJerusalem` — absolute wall-clock time in Asia/Jerusalem (the
 *    audited timestamp must be exact, not relative).
 *  - `result` — a coarse status derived from `endedAt` (`endedAt` set ⇒ the
 *    action ran to completion; null ⇒ in-flight / abandoned). The raw
 *    `actionType` stays verbatim so a future status surface can branch.
 *
 * No PII: `provider_audit_log` carries only structured action metadata +
 * the operator's own IP/UA (their accountability footprint, not a tenant's).
 */
export type ProviderSelfAuditResult = 'completed' | 'pending';

export interface ProviderSelfAuditItemVM {
  id: string;
  providerUserId: string;
  /** The mandatory access-reason recorded at action time (D.37). */
  reason: string;
  /** Raw action type verbatim (`tenant.read`, `audit.searched`, …). */
  actionType: string;
  /** First segment of `actionType` (`tenant.read` → `tenant`). */
  actionCategory: string;
  targetTable: string | null;
  targetRecordId: string | null;
  /** Customer orgs this action touched — answers "who accessed org X". */
  affectedOrgs: string[] | null;
  ip: string | null;
  userAgent: string | null;
  /** Absolute Asia/Jerusalem timestamp for the action start. */
  startedAtJerusalem: string;
  /** ISO for sorting / cursor display. */
  startedAtIso: string;
  /** Coarse status: completed (endedAt set) vs pending (endedAt null). */
  result: ProviderSelfAuditResult;
  queryCount: number | null;
}

export type { ProviderSelfAuditItem };
