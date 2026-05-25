import type { Document, DocumentType } from '@emapp/shared-types';

import { stripBidiOverrides } from '@/lib/bidi';
import { formatRelative } from '@/lib/format';
import type { DocumentViewModel } from '@/models/document.vm';

const TYPE_LABELS_HE: Record<DocumentType, string> = {
  contract: 'הסכם',
  permit: 'אישור / היתר',
  id_document: 'ת.ז.',
  floor_plan: 'תוכנית קומה',
  financial: 'מסמך פיננסי',
  other: 'אחר',
};

const TYPE_LABELS_EN: Record<DocumentType, string> = {
  contract: 'Contract',
  permit: 'Permit',
  id_document: 'ID Document',
  floor_plan: 'Floor Plan',
  financial: 'Financial',
  other: 'Other',
};

export function toDocumentViewModel(d: Document, locale: 'he' | 'en' = 'he'): DocumentViewModel {
  const labels = locale === 'he' ? TYPE_LABELS_HE : TYPE_LABELS_EN;
  return {
    id: d.id,
    // §SEC-M4 — strip bidi-override codepoints. Document name is shown
    // in <option dir="auto"> on the signature-requests/new page; that
    // element cannot contain <bdi>, so the text-level strip is the
    // ONLY line of defense for that view.
    name: stripBidiOverrides(d.name),
    type: d.type,
    typeLabel: labels[d.type],
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    sizeLabel: formatBytes(d.sizeBytes),
    isArchived: d.archivedAt !== null,
    createdRelative: formatRelative(d.createdAt, locale),
    projectId: d.projectId,
    apartmentId: d.apartmentId,
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
