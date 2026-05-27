/**
 * Wire → ViewModel adapters for the Tenant Portal (V11 A.S14b).
 *
 * Each function maps a Zod-validated wire shape from
 * `@emapp/shared-types/portal.ts` to a render-friendly VM in
 * `src/models/portal.vm.ts`. Locale-bound label sets live HERE next to
 * the matching enums (same posture as project/apartment adapters) so
 * adding a new enum value doesn't require chasing labels across the
 * codebase.
 */
import type {
  ApartmentStatus,
  ProjectStatus,
  ProjectType,
  TenantPortalApartment,
  TenantPortalDocument,
  TenantPortalMe,
  TenantPortalSignature,
} from '@emapp/shared-types';

import { stripBidiOverrides } from '@/lib/bidi';
import { formatRelative } from '@/lib/format';
import type {
  PortalApartmentRowViewModel,
  PortalDocumentViewModel,
  PortalMeViewModel,
  PortalSignatureViewModel,
} from '@/models/portal.vm';

// ──────────────────────────────────────────────────────────────────────
// Label sets (locale-bound). Same posture as project / apartment.
// ──────────────────────────────────────────────────────────────────────

const APARTMENT_STATUS_HE: Record<ApartmentStatus, string> = {
  pending: 'בהמתנה',
  contacted: 'נוצר קשר',
  meeting: 'בפגישה',
  signed: 'חתום',
  refused: 'סירב',
  unreachable: 'לא נגיש',
};

const APARTMENT_STATUS_EN: Record<ApartmentStatus, string> = {
  pending: 'Pending',
  contacted: 'Contacted',
  meeting: 'Meeting',
  signed: 'Signed',
  refused: 'Refused',
  unreachable: 'Unreachable',
};

const APARTMENT_STATUS_COLORS: Record<ApartmentStatus, PortalApartmentRowViewModel['statusColor']> =
  {
    pending: 'gray',
    contacted: 'amber',
    meeting: 'amber',
    signed: 'emerald',
    refused: 'red',
    unreachable: 'red',
  };

const PROJECT_TYPE_HE: Record<ProjectType, string> = {
  tama38_1: 'תמ"א 38/1',
  tama38_2: 'תמ"א 38/2',
  pinui_binui: 'פינוי-בינוי',
};

const PROJECT_TYPE_EN: Record<ProjectType, string> = {
  tama38_1: 'TAMA 38/1',
  tama38_2: 'TAMA 38/2',
  pinui_binui: 'Pinui-Binui',
};

const PROJECT_STATUS_HE: Record<ProjectStatus, string> = {
  planning: 'בתכנון',
  gathering_signatures: 'איסוף חתימות',
  approved: 'מאושר',
  in_construction: 'בבנייה',
  completed: 'הושלם',
  cancelled: 'בוטל',
};

const PROJECT_STATUS_EN: Record<ProjectStatus, string> = {
  planning: 'Planning',
  gathering_signatures: 'Gathering signatures',
  approved: 'Approved',
  in_construction: 'In construction',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const PROJECT_STATUS_COLORS: Record<
  ProjectStatus,
  PortalApartmentRowViewModel['project']['statusColor']
> = {
  planning: 'gray',
  gathering_signatures: 'amber',
  approved: 'emerald',
  in_construction: 'emerald',
  completed: 'gray',
  cancelled: 'red',
};

const UNIT_TYPE_HE: Record<string, string> = {
  apartment: 'דירת מגורים',
  storage: 'מחסן',
  parking: 'חנייה',
  commercial: 'מסחרי',
  office: 'משרד',
  other: 'אחר',
};

const UNIT_TYPE_EN: Record<string, string> = {
  apartment: 'Residential',
  storage: 'Storage',
  parking: 'Parking',
  commercial: 'Commercial',
  office: 'Office',
  other: 'Other',
};

const SIG_STATUS_HE: Record<'pending' | 'signed' | 'cancelled', string> = {
  pending: 'ממתין לחתימה',
  signed: 'נחתם',
  cancelled: 'בוטל',
};

const SIG_STATUS_EN: Record<'pending' | 'signed' | 'cancelled', string> = {
  pending: 'Pending signature',
  signed: 'Signed',
  cancelled: 'Cancelled',
};

const SIG_STATUS_COLORS: Record<
  'pending' | 'signed' | 'cancelled',
  PortalSignatureViewModel['statusColor']
> = {
  pending: 'amber',
  signed: 'emerald',
  cancelled: 'gray',
};

// Same document-type label set as adapters/document.ts but standalone —
// the portal's documents endpoint returns a plain `type: string` (less
// strict than the org-tier DocumentType enum at write time) so we
// fall back to an "other"-style label for unknown values rather than
// throwing.
const DOC_TYPE_HE: Record<string, string> = {
  contract: 'הסכם',
  permit: 'אישור / היתר',
  id_document: 'ת.ז.',
  floor_plan: 'תוכנית קומה',
  financial: 'מסמך פיננסי',
  other: 'אחר',
};

const DOC_TYPE_EN: Record<string, string> = {
  contract: 'Contract',
  permit: 'Permit',
  id_document: 'ID Document',
  floor_plan: 'Floor Plan',
  financial: 'Financial',
  other: 'Other',
};

// ──────────────────────────────────────────────────────────────────────
// Adapters
// ──────────────────────────────────────────────────────────────────────

export function toPortalMeViewModel(me: TenantPortalMe): PortalMeViewModel {
  // Per D.40 the tenant sees their OWN cleartext — no masking, but we
  // strip bidi-override codepoints so a malicious name from a corrupt
  // import can't spoof other UI strings.
  const cleanName = stripBidiOverrides(me.name);
  const firstWhitespace = cleanName.indexOf(' ');
  return {
    id: me.id,
    name: cleanName,
    firstName: firstWhitespace === -1 ? cleanName : cleanName.slice(0, firstWhitespace),
    email: me.email,
    nationalId: me.nationalId,
    phone: me.phone,
  };
}

export function toPortalApartmentRowViewModel(
  row: TenantPortalApartment,
  locale: 'he' | 'en' = 'he',
): PortalApartmentRowViewModel {
  const aStatusLabels = locale === 'he' ? APARTMENT_STATUS_HE : APARTMENT_STATUS_EN;
  const pStatusLabels = locale === 'he' ? PROJECT_STATUS_HE : PROJECT_STATUS_EN;
  const pTypeLabels = locale === 'he' ? PROJECT_TYPE_HE : PROJECT_TYPE_EN;
  const uTypeLabels = locale === 'he' ? UNIT_TYPE_HE : UNIT_TYPE_EN;

  // "דירה 4 · קומה 2" / "Apt 4 · Floor 2" — drop the floor segment when
  // the wire didn't carry one (storage units often have no floor).
  const floorSeg =
    row.apartment.floor === null
      ? null
      : locale === 'he'
        ? `קומה ${row.apartment.floor}`
        : `Floor ${row.apartment.floor}`;
  const numberSeg =
    locale === 'he' ? `דירה ${row.apartment.number}` : `Apt ${row.apartment.number}`;
  const apartmentDesignation = floorSeg ? `${numberSeg} · ${floorSeg}` : numberSeg;

  const sizeLabel =
    row.apartment.sizeSqm !== null
      ? `${row.apartment.sizeSqm} ${locale === 'he' ? 'מ"ר' : 'sqm'}`
      : row.apartment.areaSqm !== null
        ? `${row.apartment.areaSqm} ${locale === 'he' ? 'מ"ר' : 'sqm'}`
        : null;

  const roomsLabel =
    row.apartment.rooms !== null
      ? `${row.apartment.rooms} ${locale === 'he' ? 'חדרים' : 'rooms'}`
      : null;

  const unitTypeLabel = uTypeLabels[row.apartment.unitType] ?? row.apartment.unitType;

  // Ownership role free-text (the BE permits any string; common values
  // are "primary" / "spouse" / "heir" — we just pass through and let
  // the UI render it dir="auto").
  const ownershipRoleLabel = row.ownership.role ? stripBidiOverrides(row.ownership.role) : null;

  return {
    apartmentId: row.apartment.id,
    apartmentDesignation,
    statusColor: APARTMENT_STATUS_COLORS[row.apartment.status],
    statusLabel: aStatusLabels[row.apartment.status],
    unitTypeLabel,
    entranceLabel: row.apartment.entrance,
    sizeLabel,
    roomsLabel,
    building: {
      id: row.building.id,
      addressLine: `${stripBidiOverrides(row.building.address)}, ${stripBidiOverrides(row.building.city)}`,
    },
    project: {
      id: row.project.id,
      name: stripBidiOverrides(row.project.name),
      typeLabel: pTypeLabels[row.project.type],
      statusLabel: pStatusLabels[row.project.status],
      statusColor: PROJECT_STATUS_COLORS[row.project.status],
    },
    ownershipPctLabel: `${row.ownership.pct}%`,
    ownershipRoleLabel,
  };
}

export function toPortalDocumentViewModel(
  d: TenantPortalDocument,
  locale: 'he' | 'en' = 'he',
): PortalDocumentViewModel {
  const labels = locale === 'he' ? DOC_TYPE_HE : DOC_TYPE_EN;
  return {
    id: d.id,
    apartmentId: d.apartmentId,
    name: stripBidiOverrides(d.name),
    typeLabel: labels[d.type] ?? d.type,
    sizeLabel: formatBytes(d.sizeBytes),
    createdRelative: formatRelative(d.createdAt, locale),
    mimeType: d.mimeType,
  };
}

export function toPortalSignatureViewModel(
  s: TenantPortalSignature,
  locale: 'he' | 'en' = 'he',
): PortalSignatureViewModel {
  const labels = locale === 'he' ? SIG_STATUS_HE : SIG_STATUS_EN;
  const now = new Date();
  const expiresAt = s.expiresAt instanceof Date ? s.expiresAt : new Date(s.expiresAt);
  const isExpired = s.status === 'pending' && expiresAt.getTime() < now.getTime();
  return {
    id: s.id,
    documentId: s.documentId,
    documentName: stripBidiOverrides(s.documentName),
    status: s.status,
    statusLabel: labels[s.status],
    statusColor: SIG_STATUS_COLORS[s.status],
    expiresRelative: formatRelative(s.expiresAt, locale),
    isExpired,
    createdRelative: formatRelative(s.createdAt, locale),
    signedRelative: s.signedAt ? formatRelative(s.signedAt, locale) : null,
  };
}

export function toPortalApartmentRowViewModels(
  rows: TenantPortalApartment[],
  locale: 'he' | 'en' = 'he',
): PortalApartmentRowViewModel[] {
  return rows.map((r) => toPortalApartmentRowViewModel(r, locale));
}

export function toPortalDocumentViewModels(
  rows: TenantPortalDocument[],
  locale: 'he' | 'en' = 'he',
): PortalDocumentViewModel[] {
  return rows.map((r) => toPortalDocumentViewModel(r, locale));
}

export function toPortalSignatureViewModels(
  rows: TenantPortalSignature[],
  locale: 'he' | 'en' = 'he',
): PortalSignatureViewModel[] {
  return rows.map((r) => toPortalSignatureViewModel(r, locale));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
