import type { DocumentChecklist } from '@emapp/shared-types';

import type { DocumentChecklistViewModel } from '@/models/document-checklist.vm';

import { DOCUMENT_TYPE_LABELS_EN, DOCUMENT_TYPE_LABELS_HE } from './document';

const FALLBACK_LABEL_HE = 'מסמך';
const FALLBACK_LABEL_EN = 'Document';

/**
 * Wire → VM for the advisory project document-checklist. Resolves each MISSING
 * required type to its display label (the present ones never need a label — the
 * UI only names what's still outstanding). Pure; runs in TanStack `select`.
 */
export function toDocumentChecklistViewModel(
  data: DocumentChecklist,
  locale: 'he' | 'en' = 'he',
): DocumentChecklistViewModel {
  const labels = locale === 'he' ? DOCUMENT_TYPE_LABELS_HE : DOCUMENT_TYPE_LABELS_EN;
  const fallback = locale === 'he' ? FALLBACK_LABEL_HE : FALLBACK_LABEL_EN;
  const missing = data.items
    .filter((item) => !item.present)
    .map((item) => ({
      type: item.type,
      typeLabel: labels[item.type] ?? fallback,
    }));
  return {
    projectId: data.projectId,
    presentCount: data.presentCount,
    totalCount: data.totalCount,
    completionPct: data.completionPct,
    isComplete: data.totalCount > 0 && data.presentCount >= data.totalCount,
    missing,
  };
}
