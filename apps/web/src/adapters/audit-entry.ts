/**
 * Wire → ViewModel adapter for AuditEntry (Phase 4c S4).
 *
 * Pure function; docs/05 §9.8 pattern.
 *
 * Category map: covers the action prefixes observed across the
 * codebase (import, member, signature, project, project_assignment,
 * owner, building, apartment, ownership, document, auth, bootstrap).
 * Unknown prefixes fall through with the raw category (no hidden
 * "unknown" bucket — every audit row remains forensically identifiable
 * regardless of FE label freshness).
 */
import type { AuditActorType, AuditEntry } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { DisplayLocale } from '@/lib/locale';
import type { AuditEntryViewModel } from '@/models/audit-entry.vm';

const CATEGORY_LABELS_HE: Record<string, string> = {
  import: 'ייבוא',
  member: 'חברים',
  signature: 'חתימה',
  project: 'פרויקטים',
  project_assignment: 'שיוכים',
  owner: 'בעלי דירות',
  building: 'בניינים',
  apartment: 'דירות',
  ownership: 'בעלויות',
  document: 'מסמכים',
  auth: 'אימות',
  bootstrap: 'אתחול',
};

const CATEGORY_LABELS_EN: Record<string, string> = {
  import: 'Imports',
  member: 'Members',
  signature: 'Signatures',
  project: 'Projects',
  project_assignment: 'Assignments',
  owner: 'Owners',
  building: 'Buildings',
  apartment: 'Apartments',
  ownership: 'Ownerships',
  document: 'Documents',
  auth: 'Auth',
  bootstrap: 'Bootstrap',
};

const ACTOR_TYPE_LABELS_HE: Record<AuditActorType, string> = {
  user: 'משתמש',
  system: 'מערכת',
  provider: 'Provider',
};

const ACTOR_TYPE_LABELS_EN: Record<AuditActorType, string> = {
  user: 'User',
  system: 'System',
  provider: 'Provider',
};

function splitAction(action: string): { category: string; suffix: string } {
  const dot = action.indexOf('.');
  if (dot === -1) return { category: action, suffix: '' };
  return { category: action.slice(0, dot), suffix: action.slice(dot + 1) };
}

export function toAuditEntryViewModel(
  e: AuditEntry,
  locale: DisplayLocale = 'he',
): AuditEntryViewModel {
  const { category, suffix } = splitAction(e.action);
  const categoryLabels = locale === 'en' ? CATEGORY_LABELS_EN : CATEGORY_LABELS_HE;
  const actorLabels = locale === 'en' ? ACTOR_TYPE_LABELS_EN : ACTOR_TYPE_LABELS_HE;
  return {
    id: e.id,
    actorType: e.actorType,
    actorTypeLabel: actorLabels[e.actorType],
    actorId: e.actorId,
    actorEmail: e.actorEmail,
    action: e.action,
    category,
    // Fall back to the raw category if unmapped — forensic visibility
    // wins over visual polish.
    categoryLabel: categoryLabels[category] ?? category,
    actionSuffix: suffix,
    targetTable: e.targetTable,
    targetId: e.targetId,
    createdRelative: formatRelative(e.createdAt, locale),
    createdAtIso: e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
  };
}

export function toAuditEntryViewModels(
  items: AuditEntry[],
  locale: DisplayLocale = 'he',
): AuditEntryViewModel[] {
  return items.map((e) => toAuditEntryViewModel(e, locale));
}

export const AUDIT_CATEGORY_LABELS_HE = CATEGORY_LABELS_HE;
export const AUDIT_CATEGORY_LABELS_EN = CATEGORY_LABELS_EN;
export const AUDIT_ACTOR_TYPE_LABELS_HE = ACTOR_TYPE_LABELS_HE;
export const AUDIT_ACTOR_TYPE_LABELS_EN = ACTOR_TYPE_LABELS_EN;
