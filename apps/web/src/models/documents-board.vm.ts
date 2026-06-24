import type { DocumentParty } from '@emapp/shared-types';

/**
 * ViewModel for the DOCUMENTS org cockpit (DOCUMENTS-PROCESS-DESIGN S2).
 *
 * The wire `BoardCompleteness` carries the per-party rollup AND (S2) the
 * per-project `projectsBehind` axis. This VM pre-derives everything the
 * cockpit's situation-picture needs so the components stay presentational
 * (Doc 05 §9.8 — adapters own derivation), MIRRORING the signatures
 * `signature-pulse.vm` shape so the cockpit reuses the SAME board primitives:
 *
 *  - the ONE calm pulse sentence (projects-behind summary),
 *  - ranked project-attention cards (worst-first, each naming the missing
 *    party/types + a one-click upload deep-link),
 *  - completeness-aware fleet tiles (every project, a document-completeness
 *    sliver + "X/Y ליבה" text), worst-first.
 *
 * Ranking is NOT re-computed here — the wire `projectsBehind` is already ordered
 * worst-first by the server. The adapter maps + resolves labels only.
 *
 * NO PII: counts + type/party KEYS + the project NAME (an org-internal label,
 * bidi-stripped at the adapter). Never owner national_id / phone / name.
 */

/** One missing required document slot on a behind project — the type + its
 *  responsible party. `typeLabel` is resolved in the (pure) adapter from the
 *  shared type-label map; the PARTY label is resolved at the component via the
 *  `documents.party.*` next-intl namespace (the adapter stays pure). */
export interface DocumentMissingSlotViewModel {
  /** Raw curated doc-type key (drives the upload deep-link `?type=`). */
  type: string;
  /** Resolved doc-type display label (e.g. "נסח טאבו"). */
  typeLabel: string;
  /** The responsible party key (drives the deep-link `?party=` + `tParty(party)`). */
  party: DocumentParty;
}

/** One project that needs attention — short of its core required document set. */
export interface DocumentProjectAttentionViewModel {
  projectId: string;
  /** Bidi-stripped project name (wrap in <NameDisplay>). NOT owner PII. */
  projectName: string;
  /** Core required slots filled (the NUMERATOR of "X/Y ליבה"). */
  coreReceived: number;
  /** Core required slots total (the DENOMINATOR — never divided into `coreReceived`
   *  elsewhere; these are two facts shown as "X/Y"). */
  coreRequired: number;
  /** received/required as a 0–100 percentage, for the completeness sliver. */
  completionPct: number;
  /** The missing slots (type + party, resolved labels), in server order. */
  missing: DocumentMissingSlotViewModel[];
  /** The FIRST missing slot — drives the card's one-click "העלה {type}" deep-link
   *  to /documents/new?type=&party=&projectId=. null only if (defensively) the
   *  project is behind with no enumerated missing slot. */
  firstMissing: DocumentMissingSlotViewModel | null;
}

/** One project tile in the cockpit fleet (every in-scope project with a core
 *  requirement, calm tiles, worst-first). */
export interface DocumentFleetTileViewModel {
  projectId: string;
  projectName: string;
  coreReceived: number;
  coreRequired: number;
  completionPct: number;
  /** True when the project has met its full core set (calm success tone). */
  isComplete: boolean;
}

export interface DocumentsBoardViewModel {
  /** Ranked project-attention cards (worst-first; server order). Empty ⇒ no
   *  project is behind (the calm all-clear, when there IS a requirement). */
  attention: DocumentProjectAttentionViewModel[];
  /** Total in-scope projects that HAVE a core requirement (the pulse denominator). */
  projectsWithRequirement: number;
  /** The TRUE count of behind projects (server `projectsBehindTotal`, pre-cap). The
   *  pulse + the "met" derivation (withRequirement − this) MUST use it — never
   *  `attention.length`, which is only the capped DISPLAY count. */
  projectsBehindCount: number;
  /** How many behind projects are actually RENDERED (= `attention.length`, ≤ cap).
   *  The "+N more behind" tail is `projectsBehindCount − projectsBehindShown`. */
  projectsBehindShown: number;
  /** True when the server capped `projectsBehind` → the cockpit shows a "+N" tail. */
  projectsBehindCapped: boolean;
  /** True when ≥1 in-scope project carries a core requirement (else the board has
   *  nothing to orient against — suppress the projects pulse). */
  hasAnyRequirement: boolean;
  /** True when there IS a requirement and NOTHING is behind (calm all-clear). */
  isAllClear: boolean;
}
