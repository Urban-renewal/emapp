import type { ProviderAuditItem } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { ProviderAuditItemVM } from '@/models/provider-audit.vm';

/**
 * Wire → VM for D.37 audit-search rows.
 *
 * The `actionCategory` precompute is intentionally permissive (open
 * set): a row whose `action` is `\"\" / null / 'no-dot-here'` still
 * produces a stable VM, with `actionCategory` = `action` (entire
 * string) and the empty case → `'other'`. Pages can render unknown
 * categories with a generic icon; they will never crash on a new
 * BE action category.
 */

const ACTION_CATEGORY_PATTERN = /^([a-z][a-z0-9_-]*)/i;

export function deriveActionCategory(action: string): string {
  if (!action) return 'other';
  const m = action.match(ACTION_CATEGORY_PATTERN);
  if (!m || !m[1]) return 'other';
  return m[1].toLowerCase();
}

export function toProviderAuditItemVM(
  row: ProviderAuditItem,
  locale: 'he' | 'en' = 'he',
): ProviderAuditItemVM {
  return {
    id: row.id,
    organizationId: row.organizationId,
    actorId: row.actorId,
    actorType: row.actorType,
    action: row.action,
    actionCategory: deriveActionCategory(row.action),
    targetTable: row.targetTable,
    targetId: row.targetId,
    createdRelative: formatRelative(row.createdAt, locale),
    createdAtIso: row.createdAt.toISOString(),
  };
}

export function toProviderAuditItemVMs(
  rows: ProviderAuditItem[],
  locale: 'he' | 'en' = 'he',
): ProviderAuditItemVM[] {
  return rows.map((r) => toProviderAuditItemVM(r, locale));
}
