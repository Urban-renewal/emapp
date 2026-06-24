/**
 * DH3 (MASTER-PLAN-V13 Wave B) — heuristic document-type CLASSIFIER.
 *
 * Pure, side-effect-free, well-tested. Given the cheap signals the FE already
 * holds for a picked file (filename, declared mimeType, and OPTIONALLY a small
 * leading-bytes sample for a magic-byte sniff + a first-page text peek), it
 * returns a RANKED list of suggested `doc_type` values from the curated
 * `DocumentTypeEnum`, each with a confidence (0..1) and the signal that matched.
 *
 * SUGGEST-ONLY (the whole point): this module computes a SUGGESTION. It NEVER
 * writes, never mutates a document, never touches the DB. The human confirms
 * the type separately (same "mandatory human confirm" doctrine as D.18 / the
 * tabu auto-parse). The endpoint that exposes it is `documents.read`-gated and
 * performs no write.
 *
 * Confidence model: the rule TABLE assigns a base weight per (signal → docType)
 * match; the ranker keeps the HIGHEST-confidence hit per docType, sorts DESC,
 * and applies a SMALL multi-signal bonus when the same docType is reinforced by
 * more than one independent signal (e.g. filename `נסח` AND content marker
 * `לשכת רישום המקרקעין`). Bonus is capped so a suggestion never reads as
 * certain — the FE always offers it as a suggestion the human accepts.
 *
 * SECURITY: filename and sample bytes are EXTERNAL INPUT. We never log them,
 * never echo them back (the `reason` keys are content-free constants), never
 * use the filename as a path, and we hard-cap the sample we inspect. The
 * filename regexes are anchored/bounded (no catastrophic backtracking).
 */
import {
  CLASSIFY_SAMPLE_MAX_BYTES,
  REMEDIATION_MIN_CONFIDENCE,
  type ClassifyResult,
  type ClassifySignal,
  type ClassifySuggestion,
  type DocumentType,
} from '@emapp/shared-types';

/**
 * A filename rule: a bounded regex tested against the (lower-cased) filename,
 * the docType it suggests, the base confidence, and a stable content-free
 * reason key. Order does not matter — the ranker dedupes per docType by max.
 *
 * The regexes are deliberately simple substring/extension matchers (no nested
 * quantifiers) so they are linear-time on the 255-char-max filename.
 */
interface FilenameRule {
  readonly test: RegExp;
  readonly docType: DocumentType;
  readonly confidence: number;
  readonly reason: string;
}

/**
 * Filename → docType signal table. Hebrew + latin synonyms for each urban-
 * renewal document family. Confidences reflect how UNAMBIGUOUS the token is:
 * a `.dwg` extension is near-certain blueprint; a generic `agreement` token is
 * strong but a hair less so (it can appear in many names).
 */
export const FILENAME_RULES: readonly FilenameRule[] = [
  // land_registry — נסח טאבו (a tabu / land-registry extract).
  { test: /נסח/u, docType: 'land_registry', confidence: 0.9, reason: 'filename_nesach' },
  { test: /טאבו/u, docType: 'land_registry', confidence: 0.9, reason: 'filename_tabu_he' },
  // `tabu` as a whole token — bounded by start/end, a separator, or a dot, so it
  // matches `tabu.pdf`, `tabu_extract`, `land-tabu-2024` but NOT `tabular`.
  {
    test: /(?:^|[\s_-])tabu(?:[\s_.-]|$)/u,
    docType: 'land_registry',
    confidence: 0.85,
    reason: 'filename_tabu',
  },
  {
    test: /land[\s_-]?registry/u,
    docType: 'land_registry',
    confidence: 0.85,
    reason: 'filename_land_registry',
  },
  // agreement — הסכם / חוזה (the core signed urban-renewal agreement).
  { test: /הסכם/u, docType: 'agreement', confidence: 0.85, reason: 'filename_heskem' },
  { test: /חוזה/u, docType: 'agreement', confidence: 0.8, reason: 'filename_choze' },
  { test: /agreement/u, docType: 'agreement', confidence: 0.8, reason: 'filename_agreement' },
  { test: /contract/u, docType: 'agreement', confidence: 0.6, reason: 'filename_contract' },
  // regulation — תקנון (the building/association by-laws).
  { test: /תקנון/u, docType: 'regulation', confidence: 0.9, reason: 'filename_takanon' },
  { test: /regulation/u, docType: 'regulation', confidence: 0.8, reason: 'filename_regulation' },
  { test: /by[\s_-]?laws/u, docType: 'regulation', confidence: 0.7, reason: 'filename_bylaws' },
  // blueprint — תוכנית / שרטוט / .dwg (planning drawings).
  { test: /תוכנית/u, docType: 'blueprint', confidence: 0.8, reason: 'filename_tochnit' },
  { test: /תכנית/u, docType: 'blueprint', confidence: 0.8, reason: 'filename_tochnit_alt' },
  { test: /שרטוט/u, docType: 'blueprint', confidence: 0.8, reason: 'filename_sirtut' },
  { test: /blueprint/u, docType: 'blueprint', confidence: 0.85, reason: 'filename_blueprint' },
  { test: /\.dwg$/u, docType: 'blueprint', confidence: 0.9, reason: 'filename_dwg' },
  {
    test: /floor[\s_-]?plan/u,
    docType: 'floor_plan',
    confidence: 0.75,
    reason: 'filename_floorplan',
  },
  { test: /תשריט/u, docType: 'floor_plan', confidence: 0.7, reason: 'filename_tasrit' },
  // id_document — תעודת זהות / national-id scans.
  {
    test: /תעודת[\s_-]?זהות/u,
    docType: 'id_document',
    confidence: 0.85,
    reason: 'filename_teudat_zehut',
  },
  {
    test: /\bid[\s_-]?(card|document)\b/u,
    docType: 'id_document',
    confidence: 0.6,
    reason: 'filename_id',
  },
  // permit — היתר (building permit).
  { test: /היתר/u, docType: 'permit', confidence: 0.75, reason: 'filename_heter' },
  { test: /permit/u, docType: 'permit', confidence: 0.75, reason: 'filename_permit' },
  // financial — financial statements (the generic money doc).
  { test: /financial/u, docType: 'financial', confidence: 0.6, reason: 'filename_financial' },
  // שומת מס (tax assessment) is a MONEY doc → keep the SENSITIVE `financial`
  // suggestion. Placed above + out-ranking the appraiser's bare `שומה → survey`
  // so an ambiguous money-שומה is never demoted to a non-sensitive type
  // (red-team #502 regression fix: slice-3 removed the old `שומה → financial`
  // base rule; this restores the financial-preferring signal for the tax case).
  {
    test: /שומת[\s_-]?מס/u,
    docType: 'financial',
    confidence: 0.82,
    reason: 'filename_shumat_mas',
  },
  // ── BINDER slice 3 — deal-party taxonomy adds ───────────────────────────────
  // survey — שומה / הערכת שמאי (the appraiser's valuation). שומה used to map to
  // `financial`; the more specific `survey` type now wins for the bare appraiser
  // case (both land in the appraiser party). The `שומת מס` rule above takes the
  // tax-assessment money doc back to the sensitive `financial` suggestion.
  { test: /שומה/u, docType: 'survey', confidence: 0.72, reason: 'filename_shuma' },
  {
    test: /הערכת[\s_-]?שמאי/u,
    docType: 'survey',
    confidence: 0.8,
    reason: 'filename_haarachat_shamai',
  },
  { test: /appraisal/u, docType: 'survey', confidence: 0.7, reason: 'filename_appraisal' },
  // survey_map — מפת מדידה / תשריט מדידה (the surveyor / מודד map). NOTE: a bare
  // `תשריט` already weakly suggests floor_plan above; the מדידה qualifier makes
  // it the surveyor's measurement map, so we require the מדידה token here.
  {
    test: /מפת[\s_-]?מדידה/u,
    docType: 'survey_map',
    confidence: 0.85,
    reason: 'filename_mapat_medida',
  },
  {
    test: /תשריט[\s_-]?מדידה/u,
    docType: 'survey_map',
    confidence: 0.82,
    reason: 'filename_tasrit_medida',
  },
  {
    test: /survey[\s_-]?map/u,
    docType: 'survey_map',
    confidence: 0.75,
    reason: 'filename_survey_map',
  },
  // guarantee — ערבות / בטוחה (the contractor's bank/performance guarantee).
  { test: /ערבות/u, docType: 'guarantee', confidence: 0.8, reason: 'filename_arvut' },
  { test: /בטוחה/u, docType: 'guarantee', confidence: 0.7, reason: 'filename_betucha' },
  { test: /guarantee/u, docType: 'guarantee', confidence: 0.75, reason: 'filename_guarantee' },
  // municipal_approval — אישור / היתר עירייה (the authority's approval). The
  // עירייה qualifier distinguishes it from a generic building `permit`/היתר.
  {
    test: /אישור[\s_-]?עירייה/u,
    docType: 'municipal_approval',
    confidence: 0.82,
    reason: 'filename_ishur_iriya',
  },
  {
    test: /היתר[\s_-]?עירייה/u,
    docType: 'municipal_approval',
    confidence: 0.82,
    reason: 'filename_heter_iriya',
  },
  {
    test: /municipal[\s_-]?approval/u,
    docType: 'municipal_approval',
    confidence: 0.75,
    reason: 'filename_municipal_approval',
  },
  // schedule — לוח זמנים / תכנית עבודה (the contractor's work timetable).
  {
    test: /לוח[\s_-]?זמנים/u,
    docType: 'schedule',
    confidence: 0.8,
    reason: 'filename_luach_zmanim',
  },
  // `תכנית עבודה` must out-rank the bare `תכנית`→blueprint rule (0.8): the עבודה
  // qualifier makes it the contractor's work plan, not an architectural drawing.
  {
    test: /תכנית[\s_-]?עבודה/u,
    docType: 'schedule',
    confidence: 0.84,
    reason: 'filename_tochnit_avoda',
  },
  { test: /schedule/u, docType: 'schedule', confidence: 0.7, reason: 'filename_schedule' },
  // legal_opinion — חוות דעת משפטית (the lawyer's / עו״ד opinion).
  {
    test: /חוות[\s_-]?דעת[\s_-]?משפטית/u,
    docType: 'legal_opinion',
    confidence: 0.85,
    reason: 'filename_chavat_daat',
  },
  {
    test: /חוות[\s_-]?דעת/u,
    docType: 'legal_opinion',
    confidence: 0.7,
    reason: 'filename_chavat_daat_short',
  },
  {
    test: /legal[\s_-]?opinion/u,
    docType: 'legal_opinion',
    confidence: 0.75,
    reason: 'filename_legal_opinion',
  },
  // ── S4-taxonomy — supervisor + power-of-attorney party adds ──────────────────
  // inspection_report — דו״ח פיקוח / דו״ח מפקח (the supervisor / מפקח report). The
  // פיקוח / מפקח token is what makes a generic דו״ח the supervisor's report.
  // `דו״ח` admits the gershayim ״ (U+05F4), geresh ׳ (U+05F3), ASCII quotes, or
  // the bare `דוח` spelling — all five normalise to the same inspection report.
  {
    test: /דו["'׳״]?ח[\s_-]?פיקוח/u,
    docType: 'inspection_report',
    confidence: 0.85,
    reason: 'filename_doch_pikuach',
  },
  {
    test: /דו["'׳״]?ח[\s_-]?מפקח/u,
    docType: 'inspection_report',
    confidence: 0.84,
    reason: 'filename_doch_mefakeach',
  },
  // bare פיקוח is a strong-but-slightly-less signal (a filename can mention פיקוח
  // in other ways); still well above the 0.5 floor so it wins for `דוח_פיקוח`.
  { test: /פיקוח/u, docType: 'inspection_report', confidence: 0.72, reason: 'filename_pikuach' },
  {
    test: /inspection[\s_-]?report/u,
    docType: 'inspection_report',
    confidence: 0.78,
    reason: 'filename_inspection_report',
  },
  // power_of_attorney — ייפוי כוח (PII-DENSE → SENSITIVE). The ייפוי-כוח /
  // יפוי-כח spelling variants + the latin `power of attorney` / `poa` token.
  {
    test: /ייפוי[\s_-]?כו?ח/u,
    docType: 'power_of_attorney',
    confidence: 0.88,
    reason: 'filename_yipuy_koach',
  },
  {
    test: /יפוי[\s_-]?כו?ח/u,
    docType: 'power_of_attorney',
    confidence: 0.85,
    reason: 'filename_yipuy_koach_alt',
  },
  {
    test: /power[\s_-]?of[\s_-]?attorney/u,
    docType: 'power_of_attorney',
    confidence: 0.82,
    reason: 'filename_power_of_attorney',
  },
  // `poa` as a whole token (bounded so it never matches inside another word).
  {
    test: /(?:^|[\s_-])poa(?:[\s_.-]|$)/u,
    docType: 'power_of_attorney',
    confidence: 0.7,
    reason: 'filename_poa',
  },
];

/**
 * Content-text marker rules — phrases that, if present in the first-page text
 * (cheaply extracted from the leading bytes when the sample is plain UTF-8/text
 * or the FE supplies extracted text encoded as the sample), strongly indicate a
 * type. Confidences are high: these are document-body phrases, not filenames.
 */
interface ContentRule {
  readonly test: RegExp;
  readonly docType: DocumentType;
  readonly confidence: number;
  readonly reason: string;
}

export const CONTENT_RULES: readonly ContentRule[] = [
  {
    test: /לשכת\s+רישום\s+המקרקעין/u,
    docType: 'land_registry',
    confidence: 0.92,
    reason: 'content_lishkat_rishum',
  },
  {
    test: /נסח\s+רישום/u,
    docType: 'land_registry',
    confidence: 0.9,
    reason: 'content_nesach_rishum',
  },
  { test: /גוש[\s:]+\d+/u, docType: 'land_registry', confidence: 0.75, reason: 'content_gush' },
  {
    test: /הסכם\s+התחדשות/u,
    docType: 'agreement',
    confidence: 0.85,
    reason: 'content_heskem_hitchadshut',
  },
  {
    test: /תקנון\s+הבית\s+המשותף/u,
    docType: 'regulation',
    confidence: 0.88,
    reason: 'content_takanon_bayit',
  },
  // BINDER slice 3 — deal-party content markers.
  { test: /הערכת\s+שווי/u, docType: 'survey', confidence: 0.82, reason: 'content_haarachat_shovi' },
  {
    test: /שמאי\s+מקרקעין/u,
    docType: 'survey',
    confidence: 0.8,
    reason: 'content_shamai_mekarkein',
  },
  { test: /מפת\s+מדידה/u, docType: 'survey_map', confidence: 0.85, reason: 'content_mapat_medida' },
  {
    test: /ערבות\s+בנקאית/u,
    docType: 'guarantee',
    confidence: 0.85,
    reason: 'content_arvut_bankait',
  },
  {
    test: /חוות\s+דעת\s+משפטית/u,
    docType: 'legal_opinion',
    confidence: 0.85,
    reason: 'content_chavat_daat',
  },
  // S4-taxonomy — supervisor + power-of-attorney content markers.
  {
    test: /דו["'׳״]?ח\s+פיקוח/u,
    docType: 'inspection_report',
    confidence: 0.85,
    reason: 'content_doch_pikuach',
  },
  {
    test: /ייפוי\s+כו?ח/u,
    docType: 'power_of_attorney',
    confidence: 0.88,
    reason: 'content_yipuy_koach',
  },
];

/**
 * Magic-byte → docType signal. A DECLARED `mimeType` already gives a coarse
 * type; the magic sniff is a corroborating signal (and the truth when filename
 * is uninformative). We only map the few binary families whose leading bytes
 * are stable and that carry a meaningful TYPE hint at the doc-classification
 * level. CAD `.dwg` (AutoCAD `AC10..`) ⇒ blueprint is the strongest one.
 */
interface MagicRule {
  readonly bytes?: readonly (number | null)[];
  readonly ascii?: string;
  readonly docType?: DocumentType;
  readonly mimeHint: string;
  readonly confidence: number;
  readonly reason: string;
}

/** DWG magic = 'AC10'..'AC1032' (ASCII 'AC10'). A .dwg is a blueprint. This is
 *  the one magic family that carries a meaningful docType hint at the document-
 *  classification level (PDF/PNG/ZIP magics only corroborate the declared mime,
 *  which the FE already knows, so we don't manufacture suggestions from them). */
const DWG_MAGIC: MagicRule = {
  ascii: 'AC10',
  docType: 'blueprint',
  mimeHint: 'application/acad',
  confidence: 0.85,
  reason: 'magic_dwg',
};

/** A PDF mime is a weak prior for an urban-renewal SIGNED doc (agreement) only
 *  when NOTHING else fired — kept very low so it never out-ranks a real signal
 *  and only surfaces as a last-resort hint. */
const MIME_PRIORS: Readonly<
  Partial<Record<string, { docType: DocumentType; confidence: number; reason: string }>>
> = {
  'application/pdf': { docType: 'agreement', confidence: 0.2, reason: 'mime_pdf_weak' },
  'image/png': { docType: 'other', confidence: 0.1, reason: 'mime_image_weak' },
  'image/jpeg': { docType: 'other', confidence: 0.1, reason: 'mime_image_weak' },
};

/** Multi-signal reinforcement bonus (added once per extra independent signal
 *  agreeing on a docType), and the ceiling so a suggestion never reads 1.0. */
const MULTI_SIGNAL_BONUS = 0.05;
const CONFIDENCE_CEILING = 0.98;

/** Raw signal inputs the classifier consumes — derived from the DTO. `sample`
 *  is already decoded + size-capped by the caller (service); this pure module
 *  trusts the cap but is defensive (slices to the ceiling regardless). */
export interface ClassifierInput {
  readonly filename: string;
  readonly mimeType: string;
  /** Optional leading bytes (already base64-decoded + capped by the caller). */
  readonly sample?: Buffer;
}

interface RawHit {
  docType: DocumentType;
  confidence: number;
  signal: ClassifySignal;
  reason: string;
}

function leadingBytesMatch(
  buf: Buffer,
  rule: { ascii?: string; bytes?: readonly (number | null)[] },
): boolean {
  if (rule.ascii) {
    const expected = Buffer.from(rule.ascii, 'ascii');
    if (buf.length < expected.length) return false;
    return buf.subarray(0, expected.length).equals(expected);
  }
  if (rule.bytes) {
    if (buf.length < rule.bytes.length) return false;
    for (let i = 0; i < rule.bytes.length; i += 1) {
      const b = rule.bytes[i];
      if (b === null) continue;
      if (buf[i] !== b) return false;
    }
    return true;
  }
  return false;
}

/**
 * Heuristic: is this sample "text-ish" enough to scan for content markers?
 * We only run the content-marker regexes when the leading bytes decode as
 * mostly-printable UTF-8 (a PDF/image's binary bytes would never match a
 * Hebrew phrase anyway, but this avoids decoding garbage). A NUL byte or a high
 * ratio of control bytes ⇒ binary ⇒ skip the text scan.
 */
function looksTextual(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let control = 0;
  const n = Math.min(buf.length, 512);
  for (let i = 0; i < n; i += 1) {
    const c = buf[i] ?? 0;
    if (c === 0) return false; // NUL ⇒ binary
    // allow tab/newline/CR; count other sub-space control bytes
    if (c < 0x09 || (c > 0x0d && c < 0x20)) control += 1;
  }
  return control / n < 0.1;
}

/**
 * Classify a document from its signals. Returns a ranked `ClassifyResult`
 * (best first). PURE — no I/O, no logging, no mutation. Empty `suggestions`
 * when no signal fired (and no usable mime prior), so the FE leaves the type
 * unset for the human to choose.
 */
export function classifyDocument(input: ClassifierInput): ClassifyResult {
  const hits: RawHit[] = [];
  const filename = input.filename.toLowerCase();

  // 1) Filename signals.
  for (const rule of FILENAME_RULES) {
    if (rule.test.test(filename)) {
      hits.push({
        docType: rule.docType,
        confidence: rule.confidence,
        signal: 'filename',
        reason: rule.reason,
      });
    }
  }

  // 2) Sample-derived signals (magic byte + content text), if a sample exists.
  if (input.sample && input.sample.length > 0) {
    const sample = input.sample.subarray(0, CLASSIFY_SAMPLE_MAX_BYTES);

    // 2a) Magic-byte: DWG carries a real docType hint (blueprint).
    if (leadingBytesMatch(sample, DWG_MAGIC) && DWG_MAGIC.docType) {
      hits.push({
        docType: DWG_MAGIC.docType,
        confidence: DWG_MAGIC.confidence,
        signal: 'magic_byte',
        reason: DWG_MAGIC.reason,
      });
    }

    // 2b) Content-text markers (only when the sample looks textual).
    if (looksTextual(sample)) {
      // Decode as UTF-8; replacement chars on truncated multibyte tails are
      // harmless (we only substring-match known phrases).
      const text = sample.toString('utf8');
      for (const rule of CONTENT_RULES) {
        if (rule.test.test(text)) {
          hits.push({
            docType: rule.docType,
            confidence: rule.confidence,
            signal: 'content_text',
            reason: rule.reason,
          });
        }
      }
    }
  }

  // 3) Mime prior — only as a LAST-RESORT hint when nothing else fired (it is
  //    deliberately weak and must never out-rank a real signal). We add it now
  //    but it only survives ranking if no stronger hit exists for that type.
  const prior = MIME_PRIORS[input.mimeType];
  if (prior && hits.length === 0) {
    hits.push({
      docType: prior.docType,
      confidence: prior.confidence,
      signal: 'mime',
      reason: prior.reason,
    });
  }

  if (hits.length === 0) {
    return { suggestions: [], suggestOnly: true };
  }

  // Rank: keep the best hit per docType, then apply a multi-signal bonus for
  // each ADDITIONAL distinct signal that also voted for that docType.
  const byType = new Map<DocumentType, { best: RawHit; signals: Set<ClassifySignal> }>();
  for (const hit of hits) {
    const existing = byType.get(hit.docType);
    if (!existing) {
      byType.set(hit.docType, { best: hit, signals: new Set([hit.signal]) });
    } else {
      existing.signals.add(hit.signal);
      if (hit.confidence > existing.best.confidence) existing.best = hit;
    }
  }

  const suggestions: ClassifySuggestion[] = [];
  for (const { best, signals } of byType.values()) {
    const extraSignals = signals.size - 1;
    const boosted = Math.min(
      CONFIDENCE_CEILING,
      best.confidence + extraSignals * MULTI_SIGNAL_BONUS,
    );
    suggestions.push({
      docType: best.docType,
      confidence: Number(boosted.toFixed(4)),
      signal: best.signal,
      reason: best.reason,
    });
  }

  // Sort DESC by confidence; tie-break by docType for a STABLE order (so tests
  // and the FE see a deterministic ranking).
  suggestions.sort((a, b) => b.confidence - a.confidence || a.docType.localeCompare(b.docType));

  return { suggestions, suggestOnly: true };
}

/**
 * FL-5 — the נסח/tabu BACKFILL REMEDIATION predicate. Given the signals already
 * STORED on a pre-existing document row (its filename + declared mime — NO
 * content fetch, no PII read), decide whether it is an UNAMBIGUOUS land_registry
 * (tabu/נסח) doc that the DH3 classifier would now type `land_registry`.
 *
 * Returns the matching `land_registry` suggestion (confidence + content-free
 * reason key) ONLY when:
 *   - the classifier's TOP suggestion is `land_registry`, AND
 *   - its confidence is >= REMEDIATION_MIN_CONFIDENCE (the high-confidence
 *     floor — an ambiguous filename must NEVER auto-retype a doc; this is a
 *     security sweep, not a generic re-tagger).
 * Otherwise returns `null` (no remediation). PURE — reuses `classifyDocument`,
 * does no I/O, never logs the filename. The sweep service turns a non-null
 * result into a `type → land_registry` + `sensitive → true` (turn-ON only)
 * transition; a null result leaves the doc untouched (no false positive).
 */
export function remediationLandRegistryMatch(input: {
  readonly filename: string;
  readonly mimeType: string;
}): { confidence: number; reason: string } | null {
  // Classify from the stored metadata. No sample (the content bytes are not
  // fetched — the sweep is metadata-only; the filename carries the נסח/tabu
  // signal for a pre-DH3 upload, which is exactly the #450 population).
  const result = classifyDocument({ filename: input.filename, mimeType: input.mimeType });
  const top = result.suggestions[0];
  // The TOP-ranked suggestion must be land_registry (so a stronger non-tabu
  // signal — e.g. a filename that is mostly an agreement — never gets retyped),
  // and it must clear the high-confidence floor.
  if (!top || top.docType !== 'land_registry' || top.confidence < REMEDIATION_MIN_CONFIDENCE) {
    return null;
  }
  return { confidence: top.confidence, reason: top.reason };
}
