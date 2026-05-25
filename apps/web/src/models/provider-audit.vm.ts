import type { ProviderAuditItem } from '@emapp/shared-types';

/**
 * Provider-tier audit search ViewModel — D.37 + audit-v1.1.
 *
 * The wire `action` is a dot-separated identifier (`import.start`,
 * `auth.login`, `tenant.archive`, …). The VM precomputes:
 *  - `actionCategory` — the first segment, used for grouping/filtering
 *    UI (e.g. \"Auth\", \"Imports\"). Mapping is locale-free; pages
 *    apply Hebrew/EN labels via i18n. The category enumeration is
 *    deliberately OPEN — unknown categories fall through to `'other'`
 *    so a new BE action doesn't crash the FE.
 *  - `actorTypeLabel` is computed only at render time (i18n hook);
 *    we keep the raw `actorType` so components can branch on it.
 *
 * No PII in the audit-log wire (per BE redaction in audit.service.ts).
 */
export interface ProviderAuditItemVM {
  id: string;
  organizationId: string;
  actorId: string | null;
  actorType: 'user' | 'system' | 'provider';
  /** Raw action verbatim. */
  action: string;
  /** First segment of `action` (`import.start` → `import`). */
  actionCategory: string;
  targetTable: string | null;
  targetId: string | null;
  /** Relative timestamp for the row. */
  createdRelative: string;
  /** ISO for sorting + cursor display. */
  createdAtIso: string;
}

export type { ProviderAuditItem };
