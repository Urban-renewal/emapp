import type { Document } from '@emapp/shared-types';

import { stripBidiOverrides } from '@/lib/bidi';
import { formatRelative } from '@/lib/format';
import type { DocumentStateBadgeViewModel, DocumentViewModel } from '@/models/document.vm';

/** 2.6 — the expiry-warning window (must match the BE doc-expiry-warn window /
 *  the org-stats docsExpiringSoon filter: 30 days). */
const EXPIRY_WARN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 2.6 future-states — derive the PII-FREE legal/life-cycle badges for a row.
 * Pure + locale-independent (intents + keys only; the component localises). With
 * every future-state field null (every pre-2.6 / unset doc) this returns [] so a
 * calm row stays calm. Order = severity (rejected/expired first).
 */
function deriveStateBadges(d: Document, now: number): DocumentStateBadgeViewModel[] {
  const badges: DocumentStateBadgeViewModel[] = [];
  if (d.legalStatus === 'rejected') badges.push({ key: 'rejected', intent: 'danger' });
  if (d.validUntil) {
    const until = new Date(d.validUntil).getTime();
    if (!Number.isNaN(until)) {
      if (until < now) badges.push({ key: 'expired', intent: 'danger' });
      else if (until - now <= EXPIRY_WARN_WINDOW_MS)
        badges.push({ key: 'expiringSoon', intent: 'warning' });
    }
  }
  if (d.versionState === 'superseded') badges.push({ key: 'superseded', intent: 'neutral' });
  if (d.notaryStatus === 'required') badges.push({ key: 'awaitingNotary', intent: 'warning' });
  return badges;
}

// `Document['type']` is FREE TEXT (tolerant read) — the label map covers the
// curated `DocumentTypeEnum` types AND legacy generic ones for display, with a
// fallback for anything else (so an unknown type never renders blank).
const TYPE_LABELS_HE: Record<string, string> = {
  // real urban-renewal types (BE seeds/imports)
  agreement: 'הסכם',
  land_registry: 'נסח טאבו',
  blueprint: 'תוכנית / שרטוט',
  regulation: 'תקנון / רגולציה',
  permit: 'אישור / היתר',
  financial: 'מסמך פיננסי',
  // BINDER slice 3 — deal-party taxonomy adds
  survey: 'שומה / הערכת שמאי',
  survey_map: 'מפת מדידה / תשריט',
  guarantee: 'ערבות / בטוחה',
  municipal_approval: 'אישור / היתר עירייה',
  schedule: 'לוח זמנים / תכנית עבודה',
  legal_opinion: 'חוות דעת משפטית',
  // S4-taxonomy — supervisor + power-of-attorney party adds
  inspection_report: 'דו״ח פיקוח',
  power_of_attorney: 'ייפוי כוח',
  other: 'אחר',
  // legacy generic types (back-compat display)
  contract: 'חוזה',
  id_document: 'ת.ז.',
  floor_plan: 'תוכנית קומה',
};
const FALLBACK_LABEL_HE = 'מסמך';

const TYPE_LABELS_EN: Record<string, string> = {
  agreement: 'Agreement',
  land_registry: 'Land registry extract',
  blueprint: 'Blueprint',
  regulation: 'Regulation',
  permit: 'Permit',
  financial: 'Financial',
  // BINDER slice 3 — deal-party taxonomy adds
  survey: 'Appraisal',
  survey_map: 'Survey map',
  guarantee: 'Guarantee',
  municipal_approval: 'Municipal approval',
  schedule: 'Schedule',
  legal_opinion: 'Legal opinion',
  // S4-taxonomy — supervisor + power-of-attorney party adds
  inspection_report: 'Inspection report',
  power_of_attorney: 'Power of attorney',
  other: 'Other',
  contract: 'Contract',
  id_document: 'ID Document',
  floor_plan: 'Floor Plan',
};
const FALLBACK_LABEL_EN = 'Document';

// Phase 1 — AV scan-status display labels. The four BE-written states; the wire
// schema tolerantly degrades any unknown verdict to 'pending', so this map is
// total over `DocumentScanStatus`. NON-PII (a processing-state label).
const SCAN_STATUS_LABELS_HE: Record<string, string> = {
  pending: 'בסריקה',
  clean: 'נסרק — תקין',
  infected: 'נחסם — זוהתה תוכנה זדונית',
  error: 'הסריקה נכשלה',
};
const SCAN_STATUS_LABELS_EN: Record<string, string> = {
  pending: 'Scanning',
  clean: 'Scanned — clean',
  infected: 'Blocked — malware detected',
  error: 'Scan failed',
};

/** Resolve a parent label (project name / apartment number) for display:
 *  bidi-strip it (an org-internal label can still carry an RTL-spoof mark) and
 *  normalise the absent case to null. Never owner PII. */
function parentLabel(value: string | null | undefined): string | null {
  if (value == null) return null;
  const stripped = stripBidiOverrides(value);
  return stripped.length > 0 ? stripped : null;
}

export function toDocumentViewModel(d: Document, locale: 'he' | 'en' = 'he'): DocumentViewModel {
  const labels = locale === 'he' ? TYPE_LABELS_HE : TYPE_LABELS_EN;
  const scanLabels = locale === 'he' ? SCAN_STATUS_LABELS_HE : SCAN_STATUS_LABELS_EN;
  return {
    id: d.id,
    // §SEC-M4 — strip bidi-override codepoints. Document name is shown
    // in <option dir="auto"> on the signature-requests/new page; that
    // element cannot contain <bdi>, so the text-level strip is the
    // ONLY line of defense for that view.
    name: stripBidiOverrides(d.name),
    type: d.type,
    typeLabel: labels[d.type] ?? (locale === 'he' ? FALLBACK_LABEL_HE : FALLBACK_LABEL_EN),
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    sizeLabel: formatBytes(d.sizeBytes),
    isArchived: d.archivedAt !== null,
    createdRelative: formatRelative(d.createdAt, locale),
    projectId: d.projectId,
    apartmentId: d.apartmentId,
    // Phase 1 — non-PII processing flags + resolved parent labels.
    isSensitive: d.sensitive,
    scanStatus: d.scanStatus,
    scanStatusLabel: scanLabels[d.scanStatus] ?? scanLabels.pending!,
    isScanClean: d.scanStatus === 'clean',
    projectName: parentLabel(d.projectName),
    apartmentName: parentLabel(d.apartmentName),
    // 2.6 — derived legal/life-cycle badges (PII-FREE; [] for an unset doc).
    stateBadges: deriveStateBadges(d, Date.now()),
    validUntil: d.validUntil ? new Date(d.validUntil).toISOString() : null,
  };
}

export function toDocumentViewModels(
  items: Document[],
  locale: 'he' | 'en' = 'he',
): DocumentViewModel[] {
  return items.map((d) => toDocumentViewModel(d, locale));
}

export const DOCUMENT_TYPE_LABELS_HE = TYPE_LABELS_HE;
export const DOCUMENT_TYPE_LABELS_EN = TYPE_LABELS_EN;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
