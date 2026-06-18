import type {
  ApartmentSignatureProgress,
  Project,
  ProjectListItem,
  ProjectStatus,
  ProjectType,
  SignatureProgress,
} from '@emapp/shared-types';

import { formatApartmentLabel } from '@/lib/apartment-label';
import { stripBidiOverrides } from '@/lib/bidi';
import { formatRelative } from '@/lib/format';
import type { ApartmentSignatureProgressViewModel } from '@/models/apartment-signature-progress.vm';
import type { ProjectViewModel } from '@/models/project.vm';
import type { SignatureProgressViewModel } from '@/models/signature-progress.vm';

/**
 * Wire → ViewModel adapter (per docs/05 §9.8). Pure function. No I/O,
 * no hooks. Components never see the raw wire shape — they consume
 * `ProjectViewModel`.
 *
 * Hebrew labels are owned HERE, not in i18n messages, because they
 * are a 1:1 mapping from a locked enum (D.18) to product-specific
 * Hebrew terminology — changing one without the other would silently
 * desynchronize the UI from the contract. The status enum is LAW
 * (D.18); the label set ships with it.
 */

const TYPE_LABELS: Record<ProjectType, string> = {
  tama38_1: 'תמ"א 38/1',
  tama38_2: 'תמ"א 38/2',
  pinui_binui: 'פינוי-בינוי',
  // 'other' (migration 0062) — a future renewal track; the human name lives in
  // `typeLabel`. This generic fallback is shown only if typeLabel is null.
  other: 'מסלול אחר',
};

// D.18: planning | gathering_signatures | approved | in_construction | completed | cancelled
const STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: 'בתכנון',
  gathering_signatures: 'איסוף חתימות',
  approved: 'מאושר',
  in_construction: 'בבנייה',
  completed: 'הושלם',
  cancelled: 'בוטל',
};

const STATUS_INTENTS: Record<ProjectStatus, ProjectViewModel['intent']> = {
  planning: 'neutral',
  gathering_signatures: 'warning',
  approved: 'success',
  in_construction: 'success',
  completed: 'neutral',
  cancelled: 'danger',
};

export function toProjectViewModel(
  p: Project | ProjectListItem,
  locale: 'he' | 'en' = 'he',
): ProjectViewModel {
  const isListItem = (x: Project | ProjectListItem): x is ProjectListItem =>
    'buildingsCount' in x && typeof (x as ProjectListItem).buildingsCount === 'number';
  return {
    id: p.id,
    // §SEC-M4 — strip bidi codepoints. Project name is shown in
    // <option dir="auto"> on the imports/new page (project picker).
    name: stripBidiOverrides(p.name),
    type: p.type,
    // For a future-track ('other') project, prefer the manager-authored
    // free-text label (bidi-stripped) over the generic fallback.
    typeLabel:
      p.type === 'other' && p.typeLabel ? stripBidiOverrides(p.typeLabel) : TYPE_LABELS[p.type],
    status: p.status,
    statusLabel: STATUS_LABELS[p.status],
    intent: STATUS_INTENTS[p.status],
    targetConsentPct: p.targetSignaturePct ?? null,
    // Owner-approved staged overlay (Gate-6). Already shape-validated by the
    // wire Zod parse; null → empty array so components iterate uniformly. The
    // user-authored label is bidi-stripped like every other free-text field
    // (§SEC-M4 / RTL-spoofing defence) before it reaches the progress bar.
    signatureMilestones: (p.signatureMilestones ?? []).map((m) =>
      m.label ? { ...m, label: stripBidiOverrides(m.label) } : m,
    ),
    description: p.description ? stripBidiOverrides(p.description) : null,
    // P3 create-form enrichment (migration 0062). Free-text fields are
    // bidi-stripped (§SEC-M4 / RTL-spoofing defence) like every other
    // user-authored string; numeric/enum fields pass through verbatim.
    developerName: p.developerName ? stripBidiOverrides(p.developerName) : null,
    developerCompanyId: p.developerCompanyId ? stripBidiOverrides(p.developerCompanyId) : null,
    existingUnits: p.existingUnits ?? null,
    plannedUnits: p.plannedUnits ?? null,
    extraAreaSqm: p.extraAreaSqm ?? null,
    relocationType: p.relocationType ?? null,
    relocationNotes: p.relocationNotes ? stripBidiOverrides(p.relocationNotes) : null,
    futureTrackLabel: p.typeLabel ? stripBidiOverrides(p.typeLabel) : null,
    block: p.block ? stripBidiOverrides(p.block) : null,
    parcel: p.parcel ? stripBidiOverrides(p.parcel) : null,
    subparcel: p.subparcel ? stripBidiOverrides(p.subparcel) : null,
    isArchived: p.archivedAt !== null,
    createdRelative: formatRelative(p.createdAt, locale),
    createdAtIso: p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt),
    // Stats — present only when the BE returned ProjectListItem (list/get).
    // Adapter is the single seam — components branch on undefined to render "—".
    ...(isListItem(p)
      ? {
          buildingsCount: p.buildingsCount,
          unitsCount: p.unitsCount,
          signaturesPendingCount: p.signaturesPendingCount,
          signaturesSignedCount: p.signaturesSignedCount,
          agentsCount: p.agentsCount,
        }
      : {}),
  };
}

export function toProjectViewModels(
  items: Array<Project | ProjectListItem>,
  locale: 'he' | 'en' = 'he',
): ProjectViewModel[] {
  return items.map((p) => toProjectViewModel(p, locale));
}

/**
 * Phase-6 "תמונת מצב" — signature-progress board adapter (S5a, read-only). Pure
 * function. Counts pass through verbatim; the bar color is derived once here
 * (green when the legal threshold is met, amber otherwise) so the board
 * component stays presentational. No PII is present on the wire shape.
 */
export function toSignatureProgressViewModel(p: SignatureProgress): SignatureProgressViewModel {
  return {
    totalApartments: p.totalApartments,
    apartmentsConsented: p.apartmentsConsented,
    signaturesSigned: p.signaturesSigned,
    signaturesPending: p.signaturesPending,
    targetSignaturePct: p.targetSignaturePct,
    consentedPct: p.consentedPct,
    metThreshold: p.metThreshold,
    hasTarget: p.targetSignaturePct !== null,
    barColor: p.metThreshold ? 'green' : 'amber',
  };
}

/**
 * Phase-6 "תמונת מצב" — per-apartment drill-down adapter (S5d, read-only). Pure
 * function. Counts pass through verbatim; the human designation ("דירה {number} ·
 * קומה {floor}" when a floor is present, else "דירה {number}") and the status
 * chip intent (success=consented / warning=partial / neutral=none) are derived ONCE here
 * so the list component stays presentational. The wire carries NO PII — only the
 * apartment designation + counts + status. `number` is system-controlled (not
 * user free text) but bidi-stripped defensively, mirroring the rest of this file.
 */
const APARTMENT_STATUS_INTENTS: Record<
  ApartmentSignatureProgress['status'],
  ApartmentSignatureProgressViewModel['intent']
> = {
  consented: 'success',
  partial: 'warning',
  none: 'neutral',
};

export function toApartmentSignatureProgressViewModel(
  a: ApartmentSignatureProgress,
): ApartmentSignatureProgressViewModel {
  const number = stripBidiOverrides(a.number);
  // 7c F2 — formatApartmentLabel dedups numbers that already carry the
  // "דירה" word (imported/extracted data), fixing the live "דירה דירה 7".
  const numberSeg = formatApartmentLabel(number);
  const designation = a.floor !== null ? `${numberSeg} · קומה ${a.floor}` : numberSeg;
  return {
    apartmentId: a.apartmentId,
    number,
    floor: a.floor,
    totalOwners: a.totalOwners,
    signedOwners: a.signedOwners,
    status: a.status,
    designation,
    intent: APARTMENT_STATUS_INTENTS[a.status],
  };
}

export function toApartmentSignatureProgressViewModels(
  rows: ApartmentSignatureProgress[],
): ApartmentSignatureProgressViewModel[] {
  return rows.map(toApartmentSignatureProgressViewModel);
}

/** Exported for adapter tests + future Storybook stories. */
export const PROJECT_TYPE_LABELS = TYPE_LABELS;
export const PROJECT_STATUS_LABELS = STATUS_LABELS;
export const PROJECT_STATUS_INTENTS = STATUS_INTENTS;
