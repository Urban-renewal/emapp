import type { ProviderSelfAuditItem } from '@emapp/shared-types';

import { formatJerusalem } from '@/lib/format';
import type { ProviderSelfAuditItemVM } from '@/models/provider-self-audit.vm';

import { deriveActionCategory } from './provider-audit';

/**
 * Wire → VM for the provider self-audit log (B-PROVIDER-2).
 *
 * Reuses `deriveActionCategory` from the cross-tenant audit adapter — the
 * `actionType` shares the same dot-separated identifier shape. The
 * timestamp is rendered as an absolute Asia/Jerusalem wall-clock time
 * (audited times must be exact, not relative). `result` is derived from
 * `endedAt`: a set value means the action ran to completion.
 */
export function toProviderSelfAuditItemVM(
  row: ProviderSelfAuditItem,
  locale: 'he' | 'en' = 'he',
): ProviderSelfAuditItemVM {
  return {
    id: row.id,
    providerUserId: row.providerUserId,
    reason: row.reason,
    actionType: row.actionType,
    actionCategory: deriveActionCategory(row.actionType),
    targetTable: row.targetTable,
    targetRecordId: row.targetRecordId,
    affectedOrgs: row.affectedOrgs,
    ip: row.ip,
    userAgent: row.userAgent,
    startedAtJerusalem: formatJerusalem(row.startedAt, locale),
    startedAtIso: row.startedAt.toISOString(),
    result: row.endedAt !== null ? 'completed' : 'pending',
    queryCount: row.queryCount,
  };
}

export function toProviderSelfAuditItemVMs(
  rows: ProviderSelfAuditItem[],
  locale: 'he' | 'en' = 'he',
): ProviderSelfAuditItemVM[] {
  return rows.map((r) => toProviderSelfAuditItemVM(r, locale));
}
