/**
 * Wire → ViewModel adapter for Share (Phase 4f). Pure function.
 *
 * Optional contractor-name lookup map — Manager-only enrichment;
 * Agent/Viewer degrade to `contractorIdShort` (8-char hex prefix).
 */
import type { Share } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { DisplayLocale } from '@/lib/locale';
import { SHARE_SECTION_COUNT, countActiveSections } from '@/models/share.vm';
import type { ShareViewModel } from '@/models/share.vm';

export function toShareViewModel(
  s: Share,
  locale: DisplayLocale = 'he',
  contractorIdToName?: Map<string, string>,
): ShareViewModel {
  const active = countActiveSections(s.permissions);
  return {
    id: s.id,
    projectId: s.projectId,
    contractorId: s.contractorId,
    contractorIdShort: s.contractorId.replace(/-/g, '').slice(0, 8),
    contractorName: contractorIdToName?.get(s.contractorId),
    permissions: s.permissions,
    permissionSummary: `${active} / ${SHARE_SECTION_COUNT}`,
    isRevoked: s.revokedAt !== null,
    lastAccessedAtIso: s.lastAccessedAt ? s.lastAccessedAt.toISOString() : null,
    lastAccessedRelative: s.lastAccessedAt ? formatRelative(s.lastAccessedAt, locale) : null,
    createdAtIso: s.createdAt.toISOString(),
    createdRelative: formatRelative(s.createdAt, locale),
  };
}

export function toShareViewModels(
  items: Share[],
  locale: DisplayLocale = 'he',
  contractorIdToName?: Map<string, string>,
): ShareViewModel[] {
  return items.map((s) => toShareViewModel(s, locale, contractorIdToName));
}
