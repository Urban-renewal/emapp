import type { BoardCompleteness } from '@emapp/shared-types';

import { stripBidiOverrides } from '@/lib/bidi';
import type {
  DocumentProjectAttentionViewModel,
  DocumentsBoardViewModel,
} from '@/models/documents-board.vm';

import { DOCUMENT_TYPE_LABELS_EN, DOCUMENT_TYPE_LABELS_HE } from './document';

const FALLBACK_LABEL_HE = 'מסמך';
const FALLBACK_LABEL_EN = 'Document';

/** received/required → 0–100 (defensive on a zero/garbage denominator). */
function pct(received: number, required: number): number {
  if (required <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((received / required) * 100)));
}

/**
 * Wire → cockpit VM for the documents org cockpit (S2). Pure; runs in TanStack
 * `select`. Resolves each missing slot's TYPE label from the shared label map
 * (the PARTY label is resolved at the component via next-intl); bidi-strips the
 * project name (an org-internal label can carry an RTL-spoof mark).
 *
 * The wire `projectsBehind` is already ranked worst-first by the server — this
 * preserves that order and only maps + resolves labels. NO PII.
 */
export function toDocumentsBoardViewModel(
  data: BoardCompleteness,
  locale: 'he' | 'en' = 'he',
): DocumentsBoardViewModel {
  const labels = locale === 'he' ? DOCUMENT_TYPE_LABELS_HE : DOCUMENT_TYPE_LABELS_EN;
  const fallback = locale === 'he' ? FALLBACK_LABEL_HE : FALLBACK_LABEL_EN;

  const attention: DocumentProjectAttentionViewModel[] = data.projectsBehind.map((p) => {
    const missing = p.missing.map((m) => ({
      type: m.type,
      typeLabel: labels[m.type] ?? fallback,
      party: m.party,
    }));
    return {
      projectId: p.projectId,
      projectName: stripBidiOverrides(p.projectName),
      coreReceived: p.coreReceived,
      coreRequired: p.coreRequired,
      completionPct: pct(p.coreReceived, p.coreRequired),
      missing,
      firstMissing: missing[0] ?? null,
    };
  });

  // The TRUE behind count is now on the wire (`projectsBehindTotal`). The pulse +
  // the "met" derivation MUST use it, NEVER the capped display length (which at
  // scale under-counts → a false "the rest are completed"). `attention` stays the
  // capped DISPLAY list; `projectsBehindShown` is how many of the total we render,
  // so the "+N more behind" tail is the real overflow, not a hard-coded number.
  const projectsBehindCount = data.projectsBehindTotal;
  const projectsBehindShown = attention.length;
  const hasAnyRequirement = data.hasAnyRequirement;
  const isAllClear = hasAnyRequirement && projectsBehindCount === 0;

  return {
    attention,
    projectsWithRequirement: data.projectsWithRequirement,
    projectsBehindCount,
    projectsBehindShown,
    projectsBehindCapped: data.projectsBehindCapped,
    hasAnyRequirement,
    isAllClear,
  };
}
