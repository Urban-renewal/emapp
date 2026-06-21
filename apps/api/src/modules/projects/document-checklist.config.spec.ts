/**
 * DH2 (V13) — UNIT spec for the ADVISORY document-checklist CONFIG: the
 * required-doc-type set per track, the track-derivation from `project_type`, and
 * the completeness math. PURE — no DB, no Nest, no I/O. The endpoint integration
 * spec (projects-document-checklist.spec.ts) exercises the real DB + RLS scoping.
 */
import { DocumentTypeEnum } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  REQUIRED_DOC_TYPES_BY_TRACK,
  checklistCompletionPct,
  trackForProjectType,
} from './document-checklist.config';

describe('document-checklist config — required-set per track', () => {
  it('every track has a non-empty required set', () => {
    for (const track of ['tama38', 'pinui_binui', 'default'] as const) {
      expect(REQUIRED_DOC_TYPES_BY_TRACK[track].length).toBeGreaterThan(0);
    }
  });

  it('every required type is a valid curated DocumentType (no typos / drift)', () => {
    for (const track of ['tama38', 'pinui_binui', 'default'] as const) {
      for (const type of REQUIRED_DOC_TYPES_BY_TRACK[track]) {
        // throws if `type` is not in the curated enum → guards against drift.
        expect(() => DocumentTypeEnum.parse(type)).not.toThrow();
      }
    }
  });

  it('required sets have NO duplicate types', () => {
    for (const track of ['tama38', 'pinui_binui', 'default'] as const) {
      const set = REQUIRED_DOC_TYPES_BY_TRACK[track];
      expect(new Set(set).size).toBe(set.length);
    }
  });

  it('tama38 = agreement + land_registry + blueprint (no regulation)', () => {
    expect([...REQUIRED_DOC_TYPES_BY_TRACK.tama38]).toEqual([
      'agreement',
      'land_registry',
      'blueprint',
    ]);
  });

  it('pinui_binui is a SUPERSET of tama38 and additionally requires regulation', () => {
    const tama = new Set(REQUIRED_DOC_TYPES_BY_TRACK.tama38);
    const pinui = REQUIRED_DOC_TYPES_BY_TRACK.pinui_binui;
    for (const t of tama) expect(pinui).toContain(t);
    expect(pinui).toContain('regulation');
    expect(REQUIRED_DOC_TYPES_BY_TRACK.tama38).not.toContain('regulation');
  });
});

describe('document-checklist config — track derivation', () => {
  it('maps both תמ"א-38 variants to the single tama38 track', () => {
    expect(trackForProjectType('tama38_1')).toBe('tama38');
    expect(trackForProjectType('tama38_2')).toBe('tama38');
  });

  it('maps pinui_binui to its own track', () => {
    expect(trackForProjectType('pinui_binui')).toBe('pinui_binui');
  });

  it('falls back to default for the additive `other` and any unknown value', () => {
    expect(trackForProjectType('other')).toBe('default');
    expect(trackForProjectType('chalufat_shaked_2099')).toBe('default');
    expect(trackForProjectType('')).toBe('default');
  });
});

describe('document-checklist config — completeness math', () => {
  it('0 present of N → 0%', () => {
    expect(checklistCompletionPct(0, 3)).toBe(0);
  });

  it('all present → 100%', () => {
    expect(checklistCompletionPct(3, 3)).toBe(100);
  });

  it('partial → rounded percentage', () => {
    expect(checklistCompletionPct(1, 3)).toBe(33); // 33.33 → 33
    expect(checklistCompletionPct(2, 3)).toBe(67); // 66.67 → 67
    expect(checklistCompletionPct(3, 4)).toBe(75);
  });

  it('defensive: 0 total → 0% (no divide-by-zero)', () => {
    expect(checklistCompletionPct(0, 0)).toBe(0);
    expect(checklistCompletionPct(5, 0)).toBe(0);
  });

  it('result is always an integer in [0,100]', () => {
    for (let total = 1; total <= 7; total++) {
      for (let present = 0; present <= total; present++) {
        const pct = checklistCompletionPct(present, total);
        expect(Number.isInteger(pct)).toBe(true);
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(100);
      }
    }
  });
});
