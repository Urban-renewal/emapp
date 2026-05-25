import type { Owner } from '@emapp/shared-types';

import { stripBidiOverrides } from '@/lib/bidi';
import { formatRelative } from '@/lib/format';
import type { OwnerViewModel } from '@/models/owner.vm';

/**
 * Wire → ViewModel adapter for Owner. Masking happens server-side; this
 * is pass-through plus relative-date formatting AND bidi-strip at the
 * data layer.
 *
 * §SEC-M4 + §v9-H-3 — name + notes get `stripBidiOverrides` BEFORE
 * landing in the VM. The signature-request and ownership pages
 * embed owner names in `<option>` elements, and `<option>` cannot
 * contain `<bdi>` (browsers strip the inner element). For those
 * code paths the only line of defense is text-level cleanup at the
 * adapter — verified by browser smoke 2026-05-25 (owner with
 * embedded U+202E rendered raw in the owner-select dropdown).
 *
 * NameDisplay's belt-and-braces strip stays — defense in depth so a
 * future bypass of the adapter still neutralises the override at
 * the render layer.
 */
export function toOwnerViewModel(o: Owner, locale: 'he' | 'en' = 'he'): OwnerViewModel {
  return {
    id: o.id,
    name: stripBidiOverrides(o.name),
    email: o.email ?? null,
    nationalIdMasked: o.nationalIdMasked,
    phoneMasked: o.phoneMasked ?? null,
    notes: o.notes ? stripBidiOverrides(o.notes) : null,
    isArchived: o.archivedAt !== null,
    createdRelative: formatRelative(o.createdAt, locale),
  };
}

export function toOwnerViewModels(items: Owner[], locale: 'he' | 'en' = 'he'): OwnerViewModel[] {
  return items.map((o) => toOwnerViewModel(o, locale));
}
