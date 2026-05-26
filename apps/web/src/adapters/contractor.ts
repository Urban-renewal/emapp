/**
 * Wire → ViewModel adapter for Contractor (Phase 4f). Pure function.
 */
import type { Contractor } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { DisplayLocale } from '@/lib/locale';
import type { ContractorViewModel } from '@/models/contractor.vm';

export function toContractorViewModel(
  c: Contractor,
  locale: DisplayLocale = 'he',
): ContractorViewModel {
  return {
    id: c.id,
    name: c.name,
    contactEmail: c.contactEmail,
    contactPhone: c.contactPhone,
    companyId: c.companyId,
    specialty: c.specialty,
    notes: c.notes,
    isArchived: c.archivedAt !== null,
    createdAtIso: c.createdAt.toISOString(),
    createdRelative: formatRelative(c.createdAt, locale),
  };
}

export function toContractorViewModels(
  items: Contractor[],
  locale: DisplayLocale = 'he',
): ContractorViewModel[] {
  return items.map((c) => toContractorViewModel(c, locale));
}
