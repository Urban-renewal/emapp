import type { Owner } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { OwnerViewModel } from '@/models/owner.vm';

/** Wire → ViewModel adapter for Owner. Masking happens server-side;
 *  this is pass-through plus relative-date formatting. */
export function toOwnerViewModel(o: Owner, locale: 'he' | 'en' = 'he'): OwnerViewModel {
  return {
    id: o.id,
    name: o.name,
    email: o.email ?? null,
    nationalIdMasked: o.nationalIdMasked,
    phoneMasked: o.phoneMasked ?? null,
    notes: o.notes ?? null,
    isArchived: o.archivedAt !== null,
    createdRelative: formatRelative(o.createdAt, locale),
  };
}

export function toOwnerViewModels(items: Owner[], locale: 'he' | 'en' = 'he'): OwnerViewModel[] {
  return items.map((o) => toOwnerViewModel(o, locale));
}
