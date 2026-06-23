/**
 * G1 TaskWatcher copy composer — pure unit tests (no DB). Proves the VOICE LAW +
 * the PII-FREE contract for a system-owned "missing required document" task.
 */
import { describe, expect, it } from 'vitest';

import { composeMissingDocTask } from './task-watcher-copy';

describe('composeMissingDocTask', () => {
  it('uses the Hebrew doc-type label (taxonomy, not PII) in title + body', () => {
    const { title, description } = composeMissingDocTask('land_registry');
    expect(title).toContain('נסח טאבו');
    expect(description).toContain('נסח טאבו');
  });

  it('falls back to the raw key for an unmapped type (never an empty title)', () => {
    const { title } = composeMissingDocTask('survey_map');
    expect(title).toContain('survey_map');
    expect(title.length).toBeGreaterThan(0);
  });

  it('VOICE LAW: no system-first-person ("המערכת", "תזמנתי", "פתחתי") — framed for the user', () => {
    const { title, description } = composeMissingDocTask('agreement');
    const text = `${title} ${description}`;
    // The machine must not be the hero. No "the system did X" first-person voice.
    expect(text).not.toContain('המערכת');
    expect(text).not.toMatch(/תזמנתי|פתחתי|טיפלתי|ניתחתי/);
    // It frames a situation + a recommended action (user keeps control).
    expect(text).toMatch(/חסר|מומלץ/);
  });

  it('PII-FREE: composing with only a doc-type key cannot leak owner identity', () => {
    // The function takes ONLY a doc-type string — there is structurally no PII
    // input. Assert the output is the label-only template (no national_id/phone
    // placeholders, no interpolation seam for owner data).
    const { title, description } = composeMissingDocTask('blueprint');
    const text = `${title} ${description}`;
    expect(text.toLowerCase()).not.toContain('national');
    expect(text).not.toMatch(/\d{9}/); // no 9-digit national_id pattern
  });
});
