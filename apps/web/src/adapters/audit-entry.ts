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

/**
 * Phase 4g — universal verb map. Applies to ANY category that doesn't
 * override. Covers the common CRUD suffixes the codebase emits:
 * create / update / archive / delete / cancel / revoke / assign /
 * unassign / role_change.
 */
const VERB_LABELS_HE: Record<string, string> = {
  create: 'נוצר',
  created: 'נוצר',
  update: 'עודכן',
  updated: 'עודכן',
  archive: 'אורכב',
  archived: 'אורכב',
  delete: 'נמחק',
  cancel: 'בוטל',
  cancelled: 'בוטל',
  revoke: 'בוטל שיתוף',
  assign: 'שויך',
  unassign: 'בוטל שיוך',
  role_change: 'תפקיד שונה',
};

const VERB_LABELS_EN: Record<string, string> = {
  create: 'Created',
  created: 'Created',
  update: 'Updated',
  updated: 'Updated',
  archive: 'Archived',
  archived: 'Archived',
  delete: 'Deleted',
  cancel: 'Cancelled',
  cancelled: 'Cancelled',
  revoke: 'Revoked',
  assign: 'Assigned',
  unassign: 'Unassigned',
  role_change: 'Role changed',
};

/**
 * Per-category suffix overrides — for verbs that are domain-specific
 * or where the same suffix means different things across categories.
 * Resolution chain: category override → universal verb map → raw.
 */
const SUFFIX_OVERRIDES_HE: Record<string, Record<string, string>> = {
  import: {
    received: 'התקבל',
    start_requested: 'התחלה התבקשה',
    materialised: 'נשמר במסד',
    failed: 'נכשל',
    mapping_auto_resolved: 'מיפוי אוטומטי',
    mapping_submitted: 'מיפוי נשלח',
    awaiting_mapping: 'ממתין למיפוי',
    upload_url_minted: 'כתובת העלאה הופקה',
    upload_url_mint_failed: 'הפקת כתובת העלאה נכשלה',
    upload_integrity_unverified: 'שלמות העלאה לא אומתה',
  },
  signature: {
    preview: 'הוצגה תצוגה מקדימה',
    preview_rejected: 'תצוגה מקדימה נדחתה',
    signed: 'נחתם',
    rejected: 'נדחה',
  },
  signature_request: {
    create: 'בקשה נוצרה',
    cancel: 'בקשה בוטלה',
  },
  document: {
    finalize: 'סופי',
    download: 'הורד',
    integrity_reject: 'שלמות נדחתה',
  },
  ownership: {
    replace_set: 'הוחלף כולו',
  },
  auth: {
    login_failed: 'כניסה נכשלה',
    otp_requested: 'OTP התבקש',
    tenant_login: 'דייר התחבר',
    tenant_login_failed: 'התחברות דייר נכשלה',
  },
};

const SUFFIX_OVERRIDES_EN: Record<string, Record<string, string>> = {
  import: {
    received: 'Received',
    start_requested: 'Start requested',
    materialised: 'Materialised',
    failed: 'Failed',
    mapping_auto_resolved: 'Mapping auto-resolved',
    mapping_submitted: 'Mapping submitted',
    awaiting_mapping: 'Awaiting mapping',
    upload_url_minted: 'Upload URL minted',
    upload_url_mint_failed: 'Upload URL mint failed',
    upload_integrity_unverified: 'Upload integrity unverified',
  },
  signature: {
    preview: 'Preview shown',
    preview_rejected: 'Preview rejected',
    signed: 'Signed',
    rejected: 'Rejected',
  },
  signature_request: {
    create: 'Request created',
    cancel: 'Request cancelled',
  },
  document: {
    finalize: 'Finalised',
    download: 'Downloaded',
    integrity_reject: 'Integrity rejected',
  },
  ownership: {
    replace_set: 'Full set replaced',
  },
  auth: {
    login_failed: 'Login failed',
    otp_requested: 'OTP requested',
    tenant_login: 'Tenant login',
    tenant_login_failed: 'Tenant login failed',
  },
};

function resolveSuffix(category: string, suffix: string, locale: DisplayLocale): string {
  if (suffix.length === 0) return '';
  const overrides = locale === 'en' ? SUFFIX_OVERRIDES_EN : SUFFIX_OVERRIDES_HE;
  const verbs = locale === 'en' ? VERB_LABELS_EN : VERB_LABELS_HE;
  return overrides[category]?.[suffix] ?? verbs[suffix] ?? suffix;
}

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
    actionSuffixLabel: resolveSuffix(category, suffix, locale),
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
export const AUDIT_VERB_LABELS_HE = VERB_LABELS_HE;
export const AUDIT_VERB_LABELS_EN = VERB_LABELS_EN;
export const AUDIT_SUFFIX_OVERRIDES_HE = SUFFIX_OVERRIDES_HE;
export const AUDIT_SUFFIX_OVERRIDES_EN = SUFFIX_OVERRIDES_EN;
