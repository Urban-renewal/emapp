/**
 * Tenant Portal ViewModels — V11 A.S14b.
 *
 * Derived display strings layered over the wire shapes in
 * `@emapp/shared-types/portal.ts`. The wire carries enums + raw values;
 * the adapter resolves locale-specific labels + relative dates + size
 * labels so the React components remain dumb renderers.
 *
 * PII discipline: the tenant sees their OWN cleartext name + phone +
 * national_id per D.40 ("masked PII to themselves shown as-is").
 * `<NameDisplay>` still wraps every render-time use (bidi-spoofing
 * defense, §v9-H-3).
 */
export interface PortalMeViewModel {
  id: string;
  name: string;
  /** First whitespace token of the name — used in the hero greeting
   *  ("Welcome, {firstName}"). Falls back to the full name when no
   *  whitespace is present. */
  firstName: string;
  email: string | null;
  /** Cleartext for the tenant's OWN row (D.40). */
  nationalId: string;
  phone: string | null;
}

export interface PortalApartmentRowViewModel {
  apartmentId: string;
  /** Display label like "דירה 4 · קומה 2" / "Apt 4 · Floor 2". */
  apartmentDesignation: string;
  /** Status badge color picked from the locked palette. */
  statusColor: 'gray' | 'amber' | 'emerald' | 'red';
  statusLabel: string;
  unitTypeLabel: string;
  entranceLabel: string | null;
  sizeLabel: string | null;
  roomsLabel: string | null;
  building: {
    id: string;
    /** Single-line address — `${address}, ${city}`. */
    addressLine: string;
  };
  project: {
    id: string;
    name: string;
    typeLabel: string;
    statusLabel: string;
    statusColor: 'gray' | 'amber' | 'emerald' | 'red';
  };
  ownershipPctLabel: string;
  ownershipRoleLabel: string | null;
}

export interface PortalDocumentViewModel {
  id: string;
  apartmentId: string;
  name: string;
  typeLabel: string;
  sizeLabel: string;
  createdRelative: string;
  mimeType: string;
}

export interface PortalSignatureViewModel {
  id: string;
  documentId: string;
  documentName: string;
  status: 'pending' | 'signed' | 'cancelled';
  statusLabel: string;
  statusColor: 'amber' | 'emerald' | 'gray';
  expiresRelative: string;
  /** True when status==='pending' AND expiresAt < now. UI shows a
   *  warning chip in that case. */
  isExpired: boolean;
  createdRelative: string;
  signedRelative: string | null;
}
