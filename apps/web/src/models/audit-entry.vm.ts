/**
 * AuditEntry ViewModel — Phase 4c S4.
 *
 * The BE audit projection deliberately excludes before/after diffs +
 * ip + userAgent (apps/api/src/modules/audit/audit-read.service.ts:42).
 * Those can carry sensitive context; the Manager-facing org view
 * intentionally only surfaces WHO / WHAT / TARGET / WHEN. A future
 * Provider Admin cross-tenant view may expose more.
 *
 * Category derivation (per the user's "raw + category prefix"
 * direction): action strings like `import.created` /
 * `member.role_change` split on the first `.` — the prefix is mapped
 * to a HE/EN category label; the suffix is rendered raw (no Hebrew
 * translation in Phase 4c because there are ~50 distinct suffixes and
 * an unverified translation is worse than a raw machine-readable
 * label). Phase 4g will add a curated dictionary.
 *
 * "Unknown category" surfaces the raw category as a fallback rather
 * than hiding it — forensic value > visual polish.
 */
import type { AuditActorType } from '@emapp/shared-types';

export interface AuditEntryViewModel {
  id: string;
  /** `user` | `system` | `provider`. */
  actorType: AuditActorType;
  actorTypeLabel: string;
  actorId: string | null;
  actorEmail: string | null;
  /** Raw event name from the wire (e.g. `import.created`). */
  action: string;
  /** Domain prefix derived from `action` (`import`, `member`, etc.). */
  category: string;
  /** Locale-bound category caption; unknown categories pass the raw
   *  prefix through. */
  categoryLabel: string;
  /** Raw suffix after the first `.` — kept verbatim (forensic
   *  searchability + cursor-style audit grep). */
  actionSuffix: string;
  /** Curated HE/EN label for the action verb (Phase 4g — closes the
   *  4c "raw + category prefix" deferral). Resolution chain:
   *   (1) category-specific override (e.g. `import.received`)
   *   (2) universal verb map (`create` → "Created", …)
   *   (3) fall through to the raw suffix. */
  actionSuffixLabel: string;
  /** Target table name (e.g. `import_jobs`) — raw, server-controlled. */
  targetTable: string | null;
  targetId: string | null;
  createdRelative: string;
  createdAtIso: string;
}
