/**
 * §SEC-M4 — adapter bidi-strip invariant.
 *
 * Manual browser smoke (2026-05-25) caught: an owner with an embedded
 * U+202E in its name rendered the override RAW in the `/he/signature-
 * requests/new` owner-select dropdown. Root cause: the `<option>`
 * element cannot contain `<bdi>` (browsers strip the inner element),
 * so the NameDisplay defense did not apply to dropdown text. The
 * data-layer (adapter) is the only place where this stripping can
 * fire BEFORE the unsafe codepoints reach the DOM in those contexts.
 *
 * Same vulnerability surface in code (`dir="auto"` <option> with
 * user-supplied text):
 *   - signature-requests/new: documents + owners
 *   - imports/new: projects
 *   - apartments/[id]/ownerships: owners
 *
 * This spec enforces the FAMILY contract: every entity adapter MUST
 * strip bidi overrides on every user-supplied string field of the VM.
 * The invariant is structural — any future entity that hits a
 * `<option>` context (or any other no-bdi container — `<title>`,
 * `<textarea>` value, etc.) will be safe by default.
 *
 * Threat-model linkage:
 *  - Security: RTL-override (U+202E) lets an attacker spoof rendering
 *    of arbitrary downstream text in the same line — e.g. an owner
 *    name "John" with embedded RLO reverses the next column's display.
 *    Multi-tenant UI: that's a per-record spoof, easily weaponised.
 *  - Performance: stripBidiOverrides is a single linear regex pass
 *    (<1µs on typical strings); adapter overhead negligible.
 *  - Error handling: stripBidiOverrides is total — never throws.
 */
import { describe, expect, it } from 'vitest';

import { toDocumentViewModel } from './document';
import { toOwnerViewModel } from './owner';
import { toProjectViewModel } from './project';

// All bidi-override codepoints stripBidiOverrides removes.
// eslint-disable-next-line security/detect-bidi-characters -- intentional: test corpus
const BIDI_PAYLOAD = '‪LRE‫RLE‬PDF‭LRO‮RLO⁦LRI⁧RLI⁨FSI⁩PDI‎LRM‏RLM';

const BASE_OWNER = {
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  name: '',
  email: 'a@b.com',
  nationalIdMasked: '•••••1234',
  phoneMasked: '•••••5678',
  notes: '',
  createdAt: new Date('2026-05-25T10:00:00Z'),
  updatedAt: new Date('2026-05-25T10:00:00Z'),
  archivedAt: null,
};

const BASE_DOCUMENT = {
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  projectId: null,
  apartmentId: null,
  name: '',
  type: 'contract' as const,
  mimeType: 'application/pdf' as const,
  sizeBytes: 1024,
  contentHash: 'abc123',
  uploadedBy: '33333333-3333-3333-3333-333333333333',
  createdAt: new Date('2026-05-25T10:00:00Z'),
  updatedAt: new Date('2026-05-25T10:00:00Z'),
  archivedAt: null,
};

const BASE_PROJECT = {
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  name: '',
  type: 'tama38_2' as const,
  status: 'planning' as const,
  description: null as string | null,
  targetSignaturePct: null as number | null,
  createdBy: '44444444-4444-4444-4444-444444444444',
  startedAt: null,
  archivedAt: null,
  createdAt: new Date('2026-05-25T10:00:00Z'),
  updatedAt: new Date('2026-05-25T10:00:00Z'),
};

// Table-driven matrix — each entry is (adapter, base, mutated-field, getter).
// Adding a new entity to the matrix forces the spec to assert that its
// adapter also strips bidi. This is the family-defense: a future
// adapter that forgets to strip will fail CI before the bug ships.
const MATRIX: Array<{
  entity: string;
  field: string;
  run: (payload: string) => string;
}> = [
  {
    entity: 'owner',
    field: 'name',
    run: (p) => toOwnerViewModel({ ...BASE_OWNER, name: 'Sara' + p + 'Cohen' }, 'he').name,
  },
  {
    entity: 'owner',
    field: 'notes',
    run: (p) => toOwnerViewModel({ ...BASE_OWNER, notes: 'note' + p + 'end' }, 'he').notes ?? '',
  },
  {
    entity: 'document',
    field: 'name',
    run: (p) => toDocumentViewModel({ ...BASE_DOCUMENT, name: 'doc' + p + '.pdf' }, 'he').name,
  },
  {
    entity: 'project',
    field: 'name',
    run: (p) => toProjectViewModel({ ...BASE_PROJECT, name: 'proj' + p + 'A' }, 'he').name,
  },
  {
    entity: 'project',
    field: 'description',
    run: (p) =>
      toProjectViewModel({ ...BASE_PROJECT, description: 'desc' + p + 'end' }, 'he').description ??
      '',
  },
];

describe('§SEC-M4 — adapter bidi-strip invariant (no bidi-override codepoint may survive)', () => {
  for (const { entity, field, run } of MATRIX) {
    it(`${entity}.${field} strips ALL bidi-override codepoints`, () => {
      const out = run(BIDI_PAYLOAD);
      // Assert NONE of the dangerous codepoints survived.
      const dangerous = [
        0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f,
      ];
      const survivors = [...out]
        .map((c) => c.codePointAt(0)!)
        .filter((cp) => dangerous.includes(cp));
      expect(
        survivors,
        `${entity}.${field}: bidi codepoints survived adapter — vulnerable in <option dir="auto"> contexts (and any other no-bdi container).\nGot: ${JSON.stringify(out)}\nSurvivors: ${survivors.map((s) => s.toString(16)).join(',')}`,
      ).toEqual([]);
    });

    it(`${entity}.${field} preserves non-bidi text`, () => {
      // Sanity: stripping must not destroy the surrounding payload.
      const out = run(BIDI_PAYLOAD);
      expect(out.length).toBeGreaterThan(5);
      // Original non-bidi tokens are still present.
      expect(out).toMatch(/[A-Za-zא-ת]/);
    });
  }

  it('payload sanity — the test corpus actually contains the codepoints we expect to strip', () => {
    // Defensive: if a future maintainer edits BIDI_PAYLOAD without
    // realising they removed a codepoint, this assertion fires.
    const got = [...BIDI_PAYLOAD].map((c) => c.codePointAt(0)!);
    expect(got).toContain(0x202e); // RLO
    expect(got).toContain(0x202d); // LRO
    expect(got).toContain(0x2066); // LRI
    expect(got).toContain(0x2069); // PDI
    expect(got).toContain(0x200e); // LRM
  });
});
