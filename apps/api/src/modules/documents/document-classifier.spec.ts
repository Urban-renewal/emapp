/**
 * DH3 (MASTER-PLAN-V13 Wave B) — heuristic classifier UNIT tests.
 *
 * Pure-function pins (no DB, no Nest). Asserts the rule TABLE: each signal →
 * expected suggestion + ranking + confidence, magic-byte detection, content-
 * text markers, multi-signal reinforcement, and the SUGGEST-ONLY empty/low
 * cases. The classifier NEVER mutates anything — these are deterministic input
 * → output assertions.
 */
import { ClassifyResultSchema } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  classifyDocument,
  remediationLandRegistryMatch,
  type ClassifierInput,
} from './document-classifier';

function run(input: Partial<ClassifierInput> & { filename: string; mimeType: string }) {
  return classifyDocument({ sample: undefined, ...input });
}

function top(input: Partial<ClassifierInput> & { filename: string; mimeType: string }) {
  return run(input).suggestions[0];
}

describe('DH3 classifier · output shape', () => {
  it('always returns a ClassifyResultSchema-valid, suggest-only result', () => {
    const r = run({ filename: 'נסח.pdf', mimeType: 'application/pdf' });
    expect(ClassifyResultSchema.safeParse(r).success).toBe(true);
    expect(r.suggestOnly).toBe(true);
  });

  it('ranks suggestions DESC by confidence (best first)', () => {
    const r = run({ filename: 'נסח טאבו.pdf', mimeType: 'application/pdf' });
    const confs = r.suggestions.map((s) => s.confidence);
    for (let i = 1; i < confs.length; i += 1) {
      expect(confs[i - 1]!).toBeGreaterThanOrEqual(confs[i]!);
    }
  });
});

describe('DH3 classifier · filename signals → docType', () => {
  const cases: Array<[string, string]> = [
    ['נסח טאבו 12345.pdf', 'land_registry'],
    ['tabu_extract.pdf', 'land_registry'],
    ['land-registry.pdf', 'land_registry'],
    ['הסכם התחדשות עירונית.pdf', 'agreement'],
    ['חוזה.docx', 'agreement'],
    ['signed-agreement-final.pdf', 'agreement'],
    ['תקנון הבית המשותף.pdf', 'regulation'],
    ['regulation_v2.pdf', 'regulation'],
    ['תוכנית בניה.pdf', 'blueprint'],
    ['שרטוט.pdf', 'blueprint'],
    ['building.dwg', 'blueprint'],
    ['floor-plan.png', 'floor_plan'],
    ['תעודת זהות.jpg', 'id_document'],
    ['היתר בניה.pdf', 'permit'],
    // BINDER slice 3 — the 6 deal-party taxonomy adds.
    // Regression guard (red-team #502): a tax-assessment money doc keeps the
    // SENSITIVE `financial` suggestion and is NOT demoted to non-sensitive survey.
    ['שומת מס 2026.pdf', 'financial'],
    ['שומה מקרקעין.pdf', 'survey'],
    ['הערכת שמאי.pdf', 'survey'],
    ['מפת מדידה גוש 6941.pdf', 'survey_map'],
    ['תשריט מדידה.pdf', 'survey_map'],
    ['ערבות בנקאית.pdf', 'guarantee'],
    ['bank-guarantee.pdf', 'guarantee'],
    ['אישור עירייה.pdf', 'municipal_approval'],
    ['היתר עירייה.pdf', 'municipal_approval'],
    ['לוח זמנים לביצוע.pdf', 'schedule'],
    ['תכנית עבודה.pdf', 'schedule'],
    ['חוות דעת משפטית.pdf', 'legal_opinion'],
    // S4-taxonomy — supervisor + power-of-attorney party adds.
    ['דוח פיקוח חודש מאי.pdf', 'inspection_report'],
    ['דו״ח מפקח.pdf', 'inspection_report'],
    ['inspection-report-2026.pdf', 'inspection_report'],
    ['ייפוי כוח נוטריוני.pdf', 'power_of_attorney'],
    ['יפוי כח.pdf', 'power_of_attorney'],
    ['power-of-attorney.pdf', 'power_of_attorney'],
    ['signed_poa.pdf', 'power_of_attorney'],
  ];
  for (const [filename, expected] of cases) {
    it(`'${filename}' → top suggestion ${expected}`, () => {
      // mime is uninformative (a generic allow-listed type) so the FILENAME
      // signal is what we are pinning.
      const mime = filename.endsWith('.docx')
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : filename.endsWith('.png')
          ? 'image/png'
          : filename.endsWith('.jpg')
            ? 'image/jpeg'
            : 'application/pdf';
      const t = top({ filename, mimeType: mime });
      expect(t?.docType).toBe(expected);
      expect(t?.signal).toBe(t?.reason.startsWith('filename') ? 'filename' : t?.signal);
      expect(t?.confidence).toBeGreaterThan(0.5);
    });
  }

  it('is case-insensitive on latin tokens', () => {
    expect(top({ filename: 'AGREEMENT.PDF', mimeType: 'application/pdf' })?.docType).toBe(
      'agreement',
    );
    expect(top({ filename: 'BluePrint.dwg', mimeType: 'application/pdf' })?.docType).toBe(
      'blueprint',
    );
  });
});

describe('DH3 classifier · magic-byte signals', () => {
  it('detects a DWG (AutoCAD AC10..) → blueprint even with a neutral filename', () => {
    const dwg = Buffer.from('AC1015\x00\x00garbage', 'latin1');
    const r = run({ filename: 'drawing-001.bin', mimeType: 'application/pdf', sample: dwg });
    const blueprint = r.suggestions.find((s) => s.docType === 'blueprint');
    expect(blueprint).toBeDefined();
    expect(blueprint?.signal).toBe('magic_byte');
    expect(blueprint?.reason).toBe('magic_dwg');
  });

  it('binary (NUL-bearing) sample skips the content-text scan (no false marker)', () => {
    // PNG bytes + a Hebrew-looking tail that would match if we scanned binary.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      Buffer.from('נסח רישום', 'utf8'),
    ]);
    const r = run({ filename: 'image.png', mimeType: 'image/png', sample: png });
    // The content marker must NOT fire on a binary (NUL-containing) buffer.
    expect(r.suggestions.some((s) => s.reason === 'content_nesach_rishum')).toBe(false);
  });
});

describe('DH3 classifier · content-text markers', () => {
  it('first-page text "לשכת רישום המקרקעין" → land_registry (high confidence)', () => {
    const text = Buffer.from('מדינת ישראל\nלשכת רישום המקרקעין\nגוש: 6941 חלקה 12', 'utf8');
    const r = run({ filename: 'scan.pdf', mimeType: 'application/pdf', sample: text });
    const lr = r.suggestions.find((s) => s.docType === 'land_registry');
    expect(lr).toBeDefined();
    expect(lr?.signal).toBe('content_text');
    expect(lr?.confidence).toBeGreaterThan(0.85);
  });

  it('"תקנון הבית המשותף" in text → regulation', () => {
    const text = Buffer.from('תקנון הבית המשותף\nסעיף 1', 'utf8');
    const r = run({ filename: 'doc.txt', mimeType: 'text/plain', sample: text });
    expect(r.suggestions.find((s) => s.docType === 'regulation')).toBeDefined();
  });

  // BINDER slice 3 — content markers for the deal-party taxonomy adds.
  const partyMarkers: Array<[string, string]> = [
    ['הערכת שווי המקרקעין', 'survey'],
    ['שמאי מקרקעין מוסמך', 'survey'],
    ['מפת מדידה מצבית', 'survey_map'],
    ['ערבות בנקאית אוטונומית', 'guarantee'],
    ['חוות דעת משפטית מטעם', 'legal_opinion'],
    // S4-taxonomy — supervisor + power-of-attorney content markers.
    ['דוח פיקוח על הביצוע', 'inspection_report'],
    ['ייפוי כוח בלתי חוזר', 'power_of_attorney'],
  ];
  for (const [phrase, expected] of partyMarkers) {
    it(`content "${phrase}" → ${expected}`, () => {
      const text = Buffer.from(`${phrase}\nשורה נוספת`, 'utf8');
      const r = run({ filename: 'doc.txt', mimeType: 'text/plain', sample: text });
      const hit = r.suggestions.find((s) => s.docType === expected);
      expect(hit, `expected a ${expected} suggestion`).toBeDefined();
      expect(hit?.signal).toBe('content_text');
    });
  }
});

describe('DH3 classifier · multi-signal reinforcement', () => {
  it('filename נסח + content marker → land_registry with a confidence BONUS', () => {
    const text = Buffer.from('לשכת רישום המקרקעין\nנסח רישום', 'utf8');
    const filenameOnly = top({ filename: 'נסח.pdf', mimeType: 'application/pdf' });
    const both = run({
      filename: 'נסח.pdf',
      mimeType: 'application/pdf',
      sample: text,
    }).suggestions.find((s) => s.docType === 'land_registry');
    expect(both).toBeDefined();
    // Two independent signals → strictly higher than the single-signal score.
    expect(both!.confidence).toBeGreaterThan(filenameOnly!.confidence);
    // …but never reads as certain (ceiling < 1).
    expect(both!.confidence).toBeLessThan(1);
  });
});

describe('DH3 classifier · ambiguous / empty (suggest-only)', () => {
  it('a neutral filename + neutral mime → empty or only low-confidence hints', () => {
    const r = run({ filename: 'document-0001.pdf', mimeType: 'application/pdf' });
    // The only possible hit is the WEAK pdf mime prior (<= 0.2); never a strong
    // false positive, so the FE can leave the type unset.
    for (const s of r.suggestions) expect(s.confidence).toBeLessThanOrEqual(0.2);
  });

  it('a truly signal-free image → empty or weak "other" only', () => {
    const r = run({ filename: 'aaa.gif', mimeType: 'image/gif' });
    // image/gif has no mime prior → no suggestion at all.
    expect(r.suggestions.length).toBe(0);
  });

  it('an empty sample buffer is ignored (no magic/content signal)', () => {
    const r = run({ filename: 'x.pdf', mimeType: 'application/pdf', sample: Buffer.alloc(0) });
    expect(
      r.suggestions.every((s) => s.signal !== 'magic_byte' && s.signal !== 'content_text'),
    ).toBe(true);
  });
});

describe('DH3 classifier · security posture', () => {
  it('never echoes the raw filename in any reason key (content-free constants)', () => {
    const r = run({ filename: 'נסח-של-לקוח-פרטי-12345.pdf', mimeType: 'application/pdf' });
    for (const s of r.suggestions) {
      expect(s.reason).not.toContain('לקוח');
      expect(s.reason).toMatch(/^[a-z0-9_]+$/); // stable lowercase keys only
    }
  });

  it('a huge sample is sliced to the leading-bytes ceiling (no unbounded scan)', () => {
    // 1 MiB buffer; classifier must not hang/over-scan — it slices internally.
    const big = Buffer.concat([Buffer.from('AC1015', 'latin1'), Buffer.alloc(1_048_576)]);
    const r = run({ filename: 'x.bin', mimeType: 'application/pdf', sample: big });
    expect(r.suggestions.find((s) => s.reason === 'magic_dwg')).toBeDefined();
  });
});

describe('FL-5 · remediationLandRegistryMatch (backfill predicate)', () => {
  it('matches an unambiguous נסח/tabu filename (high confidence)', () => {
    const m = remediationLandRegistryMatch({
      filename: 'נסח טאבו.pdf',
      mimeType: 'application/pdf',
    });
    expect(m).not.toBeNull();
    expect(m!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(m!.reason).toMatch(/^[a-z0-9_]+$/); // content-free key, no filename echo
  });

  it('matches a latin `tabu` token filename', () => {
    const m = remediationLandRegistryMatch({
      filename: 'tabu_extract_2021.pdf',
      mimeType: 'application/pdf',
    });
    expect(m).not.toBeNull();
  });

  it('does NOT match a non-tabu doc (agreement) — no false positive', () => {
    expect(
      remediationLandRegistryMatch({ filename: 'הסכם התחדשות.pdf', mimeType: 'application/pdf' }),
    ).toBeNull();
  });

  it('does NOT match a blueprint / generic filename', () => {
    expect(
      remediationLandRegistryMatch({ filename: 'תוכנית בניין.pdf', mimeType: 'application/pdf' }),
    ).toBeNull();
    expect(
      remediationLandRegistryMatch({ filename: 'מסמך כללי.pdf', mimeType: 'application/pdf' }),
    ).toBeNull();
  });

  it('does NOT match `tabular.xlsx` (the bounded-token guard holds)', () => {
    expect(
      remediationLandRegistryMatch({
        filename: 'tabular_data.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).toBeNull();
  });
});
