/**
 * Wire → ViewModel adapter for ProjectAssignment (Phase 4c S2).
 *
 * The wire row is enrichment-poor (just IDs + dates). The adapter
 * takes an optional lookup map `userIdToMember` produced from the
 * `/members` list — Manager-only, so the map is `undefined` for
 * lower roles and the VM degrades gracefully to `userIdShort`.
 *
 * Pure function (no I/O / no hooks). Same docs/05 §9.8 pattern as
 * every other adapter in this codebase.
 */
import type { ProjectAssignment } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { DisplayLocale } from '@/lib/locale';
import type { ProjectAssignmentViewModel } from '@/models/project-assignment.vm';

export interface AssignmentMemberLookup {
  name: string;
  email: string;
}

export function toProjectAssignmentViewModel(
  a: ProjectAssignment,
  locale: DisplayLocale = 'he',
  userIdToMember?: Map<string, AssignmentMemberLookup>,
): ProjectAssignmentViewModel {
  const found = userIdToMember?.get(a.userId);
  const assignedAtIso =
    a.assignedAt instanceof Date ? a.assignedAt.toISOString() : String(a.assignedAt);
  // 8-char hex prefix — long enough to disambiguate visually, short
  // enough that it doesn't dominate the UI. Same convention as git
  // short SHAs.
  const userIdShort = a.userId.replace(/-/g, '').slice(0, 8);
  return {
    id: a.id,
    projectId: a.projectId,
    userId: a.userId,
    userIdShort,
    name: found?.name,
    email: found?.email,
    roleInProject: a.roleInProject,
    assignedAtIso,
    assignedRelative: formatRelative(a.assignedAt, locale),
    active: a.unassignedAt === null,
  };
}

export function toProjectAssignmentViewModels(
  items: ProjectAssignment[],
  locale: DisplayLocale = 'he',
  userIdToMember?: Map<string, AssignmentMemberLookup>,
): ProjectAssignmentViewModel[] {
  return items.map((a) => toProjectAssignmentViewModel(a, locale, userIdToMember));
}
