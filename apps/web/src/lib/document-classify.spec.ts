/**
 * S3 — confidence-band decision logic (pure). Pins the AUTO/CONFIRM/ASK
 * thresholds + the SENSITIVE downgrade. Pure-logic only (this package ships no
 * @testing-library/react — the rendered dropzone is covered by the e2e smoke
 * j3/j3b; this file pins the load-bearing decision that drives it).
 */
import type { ClassifyResult, ClassifySuggestion } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { AUTO_CONFIDENCE, CONFIRM_CONFIDENCE, decideBand } from './document-classify';

function result(suggestions: ClassifySuggestion[]): ClassifyResult {
  return { suggestions, suggestOnly: true };
}

function sugg(docType: ClassifySuggestion['docType'], confidence: number): ClassifySuggestion {
  return { docType, confidence, signal: 'filename', reason: 'test' };
}

describe('decideBand — confidence bands', () => {
  it('AUTO at/above 0.85 for a NON-sensitive type → auto-file', () => {
    const d = decideBand(result([sugg('agreement', AUTO_CONFIDENCE)]));
    expect(d.band).toBe('auto');
    expect(d.suggestedType).toBe('agreement');
    expect(d.sensitive).toBe(false);
  });

  it('CONFIRM in [0.5, 0.85) → pre-select + confirm', () => {
    const d = decideBand(result([sugg('blueprint', 0.7)]));
    expect(d.band).toBe('confirm');
    expect(d.suggestedType).toBe('blueprint');
  });

  it('boundary: exactly 0.85 is AUTO, exactly 0.5 is CONFIRM, just below 0.5 is ASK', () => {
    expect(decideBand(result([sugg('agreement', AUTO_CONFIDENCE)])).band).toBe('auto');
    expect(decideBand(result([sugg('agreement', CONFIRM_CONFIDENCE)])).band).toBe('confirm');
    expect(decideBand(result([sugg('agreement', CONFIRM_CONFIDENCE - 0.01)])).band).toBe('ask');
  });

  it('ASK below 0.5 → still carries the (weak) suggestion for the picker', () => {
    const d = decideBand(result([sugg('regulation', 0.3)]));
    expect(d.band).toBe('ask');
    expect(d.suggestedType).toBe('regulation');
  });

  it('ASK with no suggestions → no pre-selection', () => {
    const d = decideBand(result([]));
    expect(d.band).toBe('ask');
    expect(d.suggestedType).toBeNull();
    expect(d.confidence).toBe(0);
  });
});

describe('decideBand — SENSITIVE never silently auto-files', () => {
  it('a sensitive top type at AUTO confidence is DOWNGRADED to confirm', () => {
    // land_registry (נסח טאבו) is sensitive-by-type — even at 0.99 it must pause.
    const d = decideBand(result([sugg('land_registry', 0.99)]));
    expect(d.band).toBe('confirm');
    expect(d.sensitive).toBe(true);
    expect(d.suggestedType).toBe('land_registry');
  });

  it('id_document at AUTO confidence → confirm (sensitive)', () => {
    const d = decideBand(result([sugg('id_document', 0.9)]));
    expect(d.band).toBe('confirm');
    expect(d.sensitive).toBe(true);
  });

  it('financial at AUTO confidence → confirm (sensitive)', () => {
    const d = decideBand(result([sugg('financial', 0.95)]));
    expect(d.band).toBe('confirm');
    expect(d.sensitive).toBe(true);
  });

  it('a sensitive type already in CONFIRM stays confirm + flagged sensitive', () => {
    const d = decideBand(result([sugg('land_registry', 0.6)]));
    expect(d.band).toBe('confirm');
    expect(d.sensitive).toBe(true);
  });

  it('ranks by the TOP (first) suggestion only', () => {
    const d = decideBand(result([sugg('agreement', 0.7), sugg('land_registry', 0.99)]));
    // top is agreement@0.7 → confirm, non-sensitive (the sensitive one is ranked
    // lower and does not drive the band).
    expect(d.band).toBe('confirm');
    expect(d.suggestedType).toBe('agreement');
    expect(d.sensitive).toBe(false);
  });
});
