/**
 * Wire → ViewModel adapter for Note (Phase 4e). Pure function.
 * docs/05 §9.8 pattern.
 *
 * Optional `userIdToMember` lookup map (Manager-only enrichment, same
 * pattern as ProjectAssignment / Task adapters) resolves createdBy to
 * a human name. For Agent/Viewer the lookup is undefined and we fall
 * back to `createdByShort` (8-char hex prefix).
 */

import type { Note } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { DisplayLocale } from '@/lib/locale';
import type { NoteViewModel } from '@/models/note.vm';

import type { AssignmentMemberLookup } from './project-assignment';

export function toNoteViewModel(
  n: Note,
  locale: DisplayLocale = 'he',
  userIdToMember?: Map<string, AssignmentMemberLookup>,
): NoteViewModel {
  const found = userIdToMember?.get(n.createdBy);
  return {
    id: n.id,
    organizationId: n.organizationId,
    projectId: n.projectId,
    apartmentId: n.apartmentId,
    body: n.body,
    pinned: n.pinned,
    isArchived: n.archivedAt !== null,
    createdBy: n.createdBy,
    createdByShort: n.createdBy.replace(/-/g, '').slice(0, 8),
    createdByName: found?.name,
    createdAtIso: n.createdAt.toISOString(),
    createdRelative: formatRelative(n.createdAt, locale),
    updatedAtIso: n.updatedAt.toISOString(),
    updatedRelative: formatRelative(n.updatedAt, locale),
  };
}

export function toNoteViewModels(
  items: Note[],
  locale: DisplayLocale = 'he',
  userIdToMember?: Map<string, AssignmentMemberLookup>,
): NoteViewModel[] {
  // Pinned notes float to the top of any list — visual affordance the
  // BE doesn't enforce by sort order (`createdAt DESC` only). Stable
  // sort within the buckets via Array#sort (V8 timsort is stable).
  const vms = items.map((n) => toNoteViewModel(n, locale, userIdToMember));
  return [...vms].sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1));
}
