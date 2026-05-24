/**
 * Phase 7 — TemplateResolver (D.34 Layer 2) integration tests.
 *
 * Real Neon, real RLS, real mapping_templates table — verifies the
 * resolver:
 *   1. resolves when an active manual template matches by fingerprint
 *   2. defers when no template exists for these headers
 *   3. defers when an org's template is queried from a different org
 *      (RLS FORCE org-isolation — cross-tenant must NOT leak)
 *   4. defers when the template was archived (partial UNIQUE allows
 *      a fresh one for the same fingerprint; archived rows are dead)
 *   5. defers on an unapproved AGENT template (only approved templates
 *      are auto-applied — ISO A.18.1.4 — no silent PII creation from
 *      a low-confidence LLM guess)
 *   6. resolves when an approved AGENT template matches
 *   7. defers on a malformed template (defense-in-depth against a
 *      Provider Admin SQL-inserted bad row)
 *   8. returns `unknown` (NOT `reject`) when ctx is missing
 *   9. composes correctly in front of L1 LegacyAliasResolver — saved
 *      template wins over a generic alias guess
 *  10. headers fingerprint is normalised — case + whitespace agnostic
 */
import { mappingTemplates, withTenant } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../packages/db/test/setup';
import {
  fingerprintHeaders,
  LegacyAliasResolver,
  MappingResolverChain,
  TemplateResolver,
} from '../src/mapping/mapping-resolver';

let orgA: TestOrg;
let orgB: TestOrg;

/** Test fixture headers — NOT in the L1 alias table so L1 returns
 *  `unknown` and only the L2 lookup matters. */
const NOVEL_HEADERS = [
  'client_identifier',
  'cellular',
  'contact_label',
  'unit_ref',
  'street_locator',
];

const VALID_COLUMNS = {
  national_id: 0,
  phone: 1,
  name: 2,
  apartment_number: 3,
  building_address: 4,
};

async function seedTemplate(
  o: TestOrg,
  opts: {
    headers?: string[];
    columns?: Record<string, number>;
    source?: 'manual' | 'agent' | 'system';
    approved?: boolean;
    archived?: boolean;
    confidence?: string | null;
    fingerprint?: string;
  } = {},
): Promise<string> {
  const headers = opts.headers ?? NOVEL_HEADERS;
  const fp = opts.fingerprint ?? fingerprintHeaders(headers);
  const source = opts.source ?? 'manual';
  const approved = opts.approved ?? true;
  const archived = opts.archived ?? false;
  // Agent rows REQUIRE confidence; manual/system rows REQUIRE NULL.
  // The DB CHECK enforces this; we mirror it here so tests are clear.
  const confidence =
    opts.confidence !== undefined ? opts.confidence : source === 'agent' ? '85' : null;

  const [row] = await withTenant(o.id, async (tx) =>
    tx
      .insert(mappingTemplates)
      .values({
        orgId: o.id,
        fingerprint: fp,
        name: `${source}-${Date.now()}`,
        mapping: { columns: opts.columns ?? VALID_COLUMNS, headers },
        source,
        createdBy: o.users[0]!.id,
        confidence,
        approvedBy: approved ? o.users[0]!.id : null,
        approvedAt: approved ? new Date() : null,
        archivedAt: archived ? new Date() : null,
      })
      .returning({ id: mappingTemplates.id }),
  );
  return row!.id;
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`TPLA-${ts}`, `tpla-${ts}`);
  orgB = await createTestOrg(`TPLB-${ts}`, `tplb-${ts}`);
});

afterAll(async () => {
  /* pool teardown */
});

describe('Phase 7 — TemplateResolver (D.34 L2)', () => {
  it('1) approved manual template → resolved (source=template)', async () => {
    await seedTemplate(orgA, { source: 'manual' });
    const r = new TemplateResolver();
    const out = await r.resolve(NOVEL_HEADERS, { orgId: orgA.id });
    expect(out.kind).toBe('resolved');
    if (out.kind === 'resolved') {
      expect(out.source).toBe('template');
      expect(out.mapping.columns).toMatchObject(VALID_COLUMNS);
    }
  });

  it('2) no matching template → unknown', async () => {
    const r = new TemplateResolver();
    const out = await r.resolve(['no_match_a', 'no_match_b', 'no_match_c'], {
      orgId: orgA.id,
    });
    expect(out.kind).toBe('unknown');
  });

  it('3) cross-org RLS — template in org A is invisible to org B (defer)', async () => {
    // Seed in org A; query from org B with the SAME headers/fingerprint.
    const headers = ['alt_id', 'alt_phone', 'alt_name', 'alt_apt', 'alt_addr'];
    await seedTemplate(orgA, { headers });
    const r = new TemplateResolver();
    const fromB = await r.resolve(headers, { orgId: orgB.id });
    expect(fromB.kind).toBe('unknown');
    // Confirm org A actually sees it (the seed worked).
    const fromA = await r.resolve(headers, { orgId: orgA.id });
    expect(fromA.kind).toBe('resolved');
  });

  it('4) archived template → defer (partial UNIQUE excludes it)', async () => {
    const headers = ['arch_a', 'arch_b', 'arch_c', 'arch_d', 'arch_e'];
    await seedTemplate(orgA, { headers, archived: true });
    const r = new TemplateResolver();
    const out = await r.resolve(headers, { orgId: orgA.id });
    expect(out.kind).toBe('unknown');
  });

  it('5) UNAPPROVED agent template → defer (no silent PII creation)', async () => {
    const headers = ['unaprv_a', 'unaprv_b', 'unaprv_c', 'unaprv_d', 'unaprv_e'];
    await seedTemplate(orgA, {
      headers,
      source: 'agent',
      approved: false, // unapproved — agent rows allow approved_by=NULL
      confidence: '60',
    });
    const r = new TemplateResolver();
    const out = await r.resolve(headers, { orgId: orgA.id });
    expect(out.kind).toBe('unknown');
  });

  it('6) APPROVED agent template → resolved (source=template)', async () => {
    const headers = ['aprv_a', 'aprv_b', 'aprv_c', 'aprv_d', 'aprv_e'];
    await seedTemplate(orgA, {
      headers,
      source: 'agent',
      approved: true,
      confidence: '92',
    });
    const r = new TemplateResolver();
    const out = await r.resolve(headers, { orgId: orgA.id });
    expect(out.kind).toBe('resolved');
    if (out.kind === 'resolved') {
      expect(out.source).toBe('template');
    }
  });

  it('7) template with missing required canonical field → defer (defense in depth)', async () => {
    const headers = ['inc_a', 'inc_b', 'inc_c', 'inc_d', 'inc_e'];
    await seedTemplate(orgA, {
      headers,
      // Missing `phone` — the wizard Zod blocks this on create, but a
      // SQL-inserted bad row would slip through. L2 must defer rather
      // than poison the import.
      columns: {
        national_id: 0,
        // phone: MISSING
        name: 2,
        apartment_number: 3,
        building_address: 4,
      },
    });
    const r = new TemplateResolver();
    const out = await r.resolve(headers, { orgId: orgA.id });
    expect(out.kind).toBe('unknown');
  });

  it('8) ctx missing → unknown (NOT reject — pure L1 path tests must keep working)', async () => {
    const r = new TemplateResolver();
    // No ctx argument at all.
    const out1 = await r.resolve(NOVEL_HEADERS);
    expect(out1.kind).toBe('unknown');
    // Empty orgId — same posture.
    const out2 = await r.resolve(NOVEL_HEADERS, { orgId: '' });
    expect(out2.kind).toBe('unknown');
  });

  it('9) chain composition — L2 + L1; saved template WINS over L1 alias guess', async () => {
    // Use the L1-resolvable canonical headers so L1 alone WOULD resolve.
    // Then seed a L2 template with DIFFERENT column indexes. L2 must
    // win (saved template > generic guess — manager intent).
    const canonHeaders = ['national_id', 'phone', 'name', 'apartment', 'address'];
    await seedTemplate(orgA, {
      headers: canonHeaders,
      columns: {
        national_id: 99, // wildly different from L1's 0
        phone: 88,
        name: 77,
        apartment_number: 66,
        building_address: 55,
      },
    });
    const chain = new MappingResolverChain([new TemplateResolver(), new LegacyAliasResolver()]);
    const out = await chain.resolve(canonHeaders, { orgId: orgA.id });
    expect(out.kind).toBe('resolved');
    if (out.kind === 'resolved') {
      expect(out.source).toBe('template');
      expect(out.mapping.columns.national_id).toBe(99);
    }
  });

  it('10) fingerprint normalisation — case + whitespace agnostic', async () => {
    const lowercase = ['lower_a', 'lower_b', 'lower_c', 'lower_d', 'lower_e'];
    await seedTemplate(orgA, { headers: lowercase });

    // Same headers but with UPPERCASE + leading/trailing whitespace.
    const messy = ['  LOWER_A ', '  Lower_B', 'LOWER_C  ', ' lower_d ', 'LOWER_E'];
    const r = new TemplateResolver();
    const out = await r.resolve(messy, { orgId: orgA.id });
    expect(out.kind).toBe('resolved');
  });
});
