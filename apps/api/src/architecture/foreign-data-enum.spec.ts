import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuditEntrySchema, DocumentSchema, SignatureRequestStatusEnum } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

/**
 * INVARIANT — chain-risk Class 5: NO strict wire-enum over BE-owned free text.
 *
 * A wire READ schema must not strictly `z.enum` a value the BE owns as free
 * `text` with no DB CHECK. That was DV-MGR-DOCS: the FE `DocumentTypeEnum`
 * (contract/permit/…) was DISJOINT from the BE's real free-text doc types
 * (agreement/blueprint/regulation), so `z.array(DocumentSchema).parse` threw on
 * every seeded row and TanStack swallowed it → the documents surface + the
 * signature document-picker silently broke. See docs/CHAIN-RISK-REGISTER.md.
 *
 * Each free-text-backed categorical column must be protected by EXACTLY ONE of:
 *   (a) a DB pgEnum, (b) a DB CHECK whose values == the wire enum, or
 *   (c) a tolerant wire schema (`z.string()`), with the FE mapping known values
 *       to labels + a fallback.
 */
const SCHEMA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'src',
  'schema',
);

function baseDoc(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    organizationId: '22222222-2222-2222-2222-222222222222',
    projectId: null,
    apartmentId: null,
    name: 'f.pdf',
    type: 'agreement',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    contentHash: 'a'.repeat(64),
    uploadedBy: '33333333-3333-3333-3333-333333333333',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    archivedAt: null,
    ...over,
  };
}

function baseAudit(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    organizationId: '22222222-2222-2222-2222-222222222222',
    actorId: '33333333-3333-3333-3333-333333333333',
    actorType: 'user',
    actorEmail: null,
    action: 'projects.create',
    targetTable: 'projects',
    targetId: '44444444-4444-4444-4444-444444444444',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    ...over,
  };
}

describe('chain-risk Class 5 — wire schemas tolerate BE-owned free-text values', () => {
  // (c) tolerant — the DV-MGR-DOCS regression: an arbitrary stored type must parse.
  it('DocumentSchema.type accepts an arbitrary stored type (DV-MGR-DOCS regression)', () => {
    expect(() => DocumentSchema.parse(baseDoc({ type: 'some_imported_type_xyz' }))).not.toThrow();
    expect(() => DocumentSchema.parse(baseDoc({ type: 'regulation' }))).not.toThrow();
  });

  // (c) tolerant — audit `action` is open-vocabulary (80+ values); must be z.string.
  it('AuditEntrySchema.action accepts an arbitrary action string', () => {
    expect(() =>
      AuditEntrySchema.parse(baseAudit({ action: 'some.brand.new.action' })),
    ).not.toThrow();
  });

  // (b) CHECK == wire enum — drift guard: if the BE widens the CHECK without
  //     widening the wire enum (or vice-versa), the signature list would break.
  it('signature_requests.status DB CHECK exactly equals the wire SignatureRequestStatusEnum', () => {
    const src = readFileSync(join(SCHEMA_DIR, 'artifacts.ts'), 'utf8');
    const m = src.match(/signature_requests_status_valid[\s\S]*?IN \(([^)]*)\)/);
    expect(m, 'the signature_requests status CHECK constraint must exist').toBeTruthy();
    const dbValues = ((m?.[1] ?? '').match(/'[a-z_]+'/g) ?? [])
      .map((s) => s.replace(/'/g, ''))
      .sort();
    expect(dbValues).toEqual([...SignatureRequestStatusEnum.options].sort());
  });

  // RATCHET — the registry of categorical free-text columns + their protection.
  // If a NEW `text()` column named type/status/kind/action/format/method appears
  // in the schema, this fails — forcing the author to CLASSIFY it (add a CHECK /
  // pgEnum, OR make the wire schema tolerant) and record it here. That is the
  // structural prevention for the next DV-MGR-DOCS.
  it('every categorical free-text column is a KNOWN, classified one (no unclassified new one)', () => {
    const CATEGORICAL = /\b(\w*(?:type|status|kind|action|format|method))\b:\s*text\(/i;
    const KNOWN = new Set<string>([
      'type', // documents.type → tolerant wire (z.string) [was DV-MGR-DOCS]
      'mimeType', // documents.mime_type → DocumentMimeEnum allow-list (fail-closed)
      'status', // signature_requests.status → DB CHECK == wire enum
      'scanStatus', // documents.scan_status → DB CHECK documents_scan_status_valid IN ('pending','clean','infected','error') (migration 0056)
      'signatureFormat', // signatures.signature_format → fixed 'svg'
      'authMethod', // signatures.auth_method → BE-controlled
      'method', // pii_processing_consents.method → BE-controlled provenance label ('public_sign_v1'); never client free-text (migration 0059)
      'actorType', // audit_log.actor_type → enum-matches BE (user/system/provider)
      'action', // audit_log.action → tolerant wire (z.string)
      'targetTable', // audit_log.target_table → free text, never wire-enum'd
      'scopeType', // role_assignments.scope_type → DB CHECK IN ('org','project')
      'actionType', // provider_audit_log.action_type → DB CHECK (migration 0034)
      'unitType', // apartments.unit_type → READ wires are tolerant (z.string); strict enum only on the WRITE input
      'kind', // building_sections.kind → strict enum only on CreateProjectSectionInput (WRITE); no READ-wire strict-enum
    ]);
    const found = new Set<string>();
    for (const f of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(SCHEMA_DIR, f), 'utf8');
      for (const line of src.split('\n')) {
        const m = CATEGORICAL.exec(line);
        if (m?.[1]) found.add(m[1]);
      }
    }
    const unclassified = [...found].filter((c) => !KNOWN.has(c));
    expect(
      unclassified,
      `New categorical free-text column(s) ${JSON.stringify(unclassified)} — classify each ` +
        `(DB CHECK/pgEnum OR tolerant wire schema) and add to KNOWN. See CHAIN-RISK-REGISTER.md (Class 5).`,
    ).toEqual([]);
  });
});
