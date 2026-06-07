/**
 * D.37 / Phase 6.5 — `GET /provider/tenants` NAME SEARCH (`query.q`) spec.
 *
 * Service-level integration against the real Neon dev DB. Exercises the new
 * optional `q` substring search added to `ProviderTenantsService.list`:
 *
 *   ilike(organizations.name, `%${q.replace(/[%_\\]/g, '\\$&')}%`)
 *
 * combined with the existing keyset cursor via `and(cursorPred, qPred)`.
 *
 * Because this suite runs against a SHARED dev DB alongside other specs that
 * also seed organizations, the searchable keywords are FUSED to a per-run
 * token (e.g. `<RUN>alpha`). That makes a single `q` value both run-scoped
 * (only our rows can match) AND a real case-insensitivity test. Assertions
 * are otherwise scoped by org id, never by global row counts.
 *
 * NOTE: `withProvider` rejects an access reason shorter than 20 chars
 * (reason_low_quality) — every reason below is deliberately >= 20 chars.
 *
 * Coverage:
 *   SEARCH-1  case-insensitive substring — q='<RUN>alpha' (lowercase) matches
 *             "<RUN>alpha Renewal" + "<RUN>gamma <RUN>alpha Group", not Beta
 *   SEARCH-2  different case — q='<RUN>BETA' matches the Beta org
 *   SEARCH-3  no match — q a string no org contains → data: []
 *   SEARCH-4  no q — unchanged behavior, our orgs still all returned
 *   SEARCH-5  WILDCARD ESCAPING — q='%' must NOT match all rows (the % is
 *             escaped to a literal); only the org with a literal percent shows
 *   SEARCH-5b literal percent — q='100%' matches an org named "...100% ..."
 *   SEARCH-5c underscore escaping — q with '_' is a literal, not a wildcard
 *   SEARCH-6  q + pagination — filtered set >limit yields has_more + a cursor
 *             whose next page continues the SAME filtered set with no overlap
 *   SEARCH-7  audit — the q value is recorded in metadata.filter.q
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import {
  createTestOrg,
  createTestProviderUser,
  type TestProviderUser,
} from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import type { ProviderPrincipal } from './current-provider.decorator';
import { ProviderTenantsService } from './provider-tenants.service';

let provider: TestProviderUser;
let svc: ProviderTenantsService;
let auditStartMarker: Date;

// Per-run token FUSED to each keyword in the seeded org names so a single `q`
// value is both run-scoped and a case-insensitivity test. Lowercase-safe, no
// LIKE metacharacters.
const RUN = 'srch' + Date.now().toString(36);

// Seeded orgs (ids captured so assertions are id-scoped, not count-scoped).
let alphaRenewal: { id: string };
let betaTowers: { id: string };
let gammaAlpha: { id: string };
let percentOrg: { id: string };

function principal(): ProviderPrincipal {
  return {
    sub: provider.id,
    ip: '203.0.113.7',
    userAgent: 'P6.5-search-spec/1.0',
  };
}

async function ourAuditRows(): Promise<
  Array<{ reason: string; action_type: string; metadata: Record<string, unknown> }>
> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{
      reason: string;
      action_type: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT reason, action_type, metadata
       FROM provider_audit_log
       WHERE provider_user_id = $1 AND started_at >= $2
       ORDER BY started_at ASC`,
      [provider.id, auditStartMarker.toISOString()],
    );
    return r.rows;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  provider = await createTestProviderUser();
  svc = new ProviderTenantsService();
  auditStartMarker = new Date();

  // Distinct names. The searchable keyword is fused to RUN so e.g.
  // `q='<RUN>alpha'` is run-scoped AND tests substring + case-insensitivity.
  //   "<RUN>alpha Renewal"          → contains "<RUN>alpha"
  //   "<RUN>beta Towers"            → contains "<RUN>beta", NOT "<RUN>alpha"
  //   "<RUN>gamma <RUN>alpha Group" → contains "<RUN>alpha"
  //   "<RUN>100% Renewal"           → contains "<RUN>100%" (LITERAL percent)
  alphaRenewal = await createTestOrg(`${RUN}alpha Renewal`, `${RUN}-alpha-renewal`);
  betaTowers = await createTestOrg(`${RUN}beta Towers`, `${RUN}-beta-towers`);
  gammaAlpha = await createTestOrg(`${RUN}gamma ${RUN}alpha Group`, `${RUN}-gamma-alpha`);
  percentOrg = await createTestOrg(`${RUN}100% Renewal`, `${RUN}-percent`);
}, 60_000);

afterAll(() => {
  // pools are shared singletons — global teardown handles them
});

describe('GET /provider/tenants — name search (query.q)', () => {
  it('SEARCH-1) case-insensitive substring — q="<RUN>alpha" (lowercase) matches the two alpha orgs, NOT the Beta org', async () => {
    // q is lowercase; org names use "alpha" mixed into "Alpha"/"gamma ...alpha".
    const result = await svc.list(principal(), 'search lowercase alpha keyword match', {
      limit: 100,
      q: `${RUN}alpha`,
    });
    const ids = result.data.map((t) => t.id);
    expect(ids).toContain(alphaRenewal.id);
    expect(ids).toContain(gammaAlpha.id);
    expect(ids).not.toContain(betaTowers.id);
    // Run-scoped: among OUR four orgs, exactly the two alpha-orgs match.
    const ourIds = [alphaRenewal.id, betaTowers.id, gammaAlpha.id, percentOrg.id];
    const ourMatches = result.data.filter((t) => ourIds.includes(t.id)).map((t) => t.id);
    expect(ourMatches.sort()).toEqual([alphaRenewal.id, gammaAlpha.id].sort());
  });

  it('SEARCH-2) different case — q="<RUN>BETA" (uppercase) matches the Beta org', async () => {
    const result = await svc.list(principal(), 'search uppercase BETA keyword match', {
      limit: 100,
      q: `${RUN}BETA`,
    });
    const ids = result.data.map((t) => t.id);
    expect(ids).toContain(betaTowers.id);
    expect(ids).not.toContain(alphaRenewal.id);
    expect(ids).not.toContain(gammaAlpha.id);
  });

  it('SEARCH-3) no match — q points at a non-existent string → data: [] + has_more false', async () => {
    const result = await svc.list(principal(), 'search yields no matching orgs at all', {
      limit: 5,
      q: `${RUN}zzz-no-match-${randomUUID()}`,
    });
    expect(result.data).toEqual([]);
    expect(result.page.has_more).toBe(false);
    expect(result.page.cursor).toBeNull();
  });

  it('SEARCH-4) no q — unchanged behavior, all of our seeded orgs are returned', async () => {
    const result = await svc.list(principal(), 'search baseline no q filter applied', {
      limit: 100,
    });
    const ids = new Set(result.data.map((t) => t.id));
    expect(ids.has(alphaRenewal.id)).toBe(true);
    expect(ids.has(betaTowers.id)).toBe(true);
    expect(ids.has(gammaAlpha.id)).toBe(true);
    expect(ids.has(percentOrg.id)).toBe(true);
  });

  it('SEARCH-5) WILDCARD ESCAPING — q="%" must NOT match all rows; only names with a LITERAL percent match', async () => {
    // If escaping were broken, "%" → ILIKE '%%%' → matches EVERY org. The
    // implementation escapes % to a literal, so only names containing a real
    // percent sign match. Among OUR four orgs, only "100% Renewal" qualifies.
    const result = await svc.list(principal(), 'search bare percent must be escaped literal', {
      limit: 100,
      q: '%',
    });
    const ids = result.data.map((t) => t.id);
    // The non-percent orgs must be ABSENT (none contain a literal '%').
    expect(ids).not.toContain(alphaRenewal.id);
    expect(ids).not.toContain(betaTowers.id);
    expect(ids).not.toContain(gammaAlpha.id);
    // The org with a literal '%' SHOULD be present.
    expect(ids).toContain(percentOrg.id);
  });

  it('SEARCH-5b) literal percent — q="<RUN>100%" matches the org named "<RUN>100% Renewal"', async () => {
    const result = await svc.list(principal(), 'search literal percent sign substring', {
      limit: 100,
      q: `${RUN}100%`,
    });
    const ids = result.data.map((t) => t.id);
    expect(ids).toContain(percentOrg.id);
    // The non-percent orgs must not match this literal-percent query.
    expect(ids).not.toContain(alphaRenewal.id);
    expect(ids).not.toContain(betaTowers.id);
    expect(ids).not.toContain(gammaAlpha.id);
  });

  it('SEARCH-5c) underscore is escaped — q with "_" is a literal, not a single-char wildcard', async () => {
    // "<RUN>alph_" with a literal underscore must NOT match "<RUN>alpha"
    // (which it would if "_" were an unescaped LIKE single-char wildcard).
    const result = await svc.list(principal(), 'search underscore must be escaped literal', {
      limit: 100,
      q: `${RUN}alph_`,
    });
    const ids = result.data.map((t) => t.id);
    expect(ids).not.toContain(alphaRenewal.id);
    expect(ids).not.toContain(gammaAlpha.id);
  });

  it('SEARCH-6) q + pagination — filtered set >limit yields has_more + cursor; next page continues SAME filter with no overlap', async () => {
    // Our run-scoped alpha query matches exactly two orgs. limit=1 → page 1
    // has 1 row + has_more=true; page 2 (with cursor + SAME q) yields the
    // other, with zero overlap.
    const q = `${RUN}alpha`;
    const page1 = await svc.list(principal(), 'search paginated alpha filter page one', {
      limit: 1,
      q,
    });
    expect(page1.data.length).toBe(1);
    expect(page1.page.has_more).toBe(true);
    expect(page1.page.cursor).toBeTruthy();
    const firstId = page1.data[0]!.id;

    const page2 = await svc.list(principal(), 'search paginated alpha filter page two', {
      limit: 1,
      q,
      cursor: page1.page.cursor!,
    });
    const secondIds = page2.data.map((t) => t.id);
    // No overlap with page 1.
    expect(secondIds).not.toContain(firstId);
    // The second page must STILL be filtered (only our alpha orgs surface).
    const expectedAlpha = new Set([alphaRenewal.id, gammaAlpha.id]);
    for (const id of secondIds) {
      expect(expectedAlpha.has(id)).toBe(true);
    }
    // Union of both pages = exactly our two alpha orgs.
    const union = new Set<string>([firstId, ...secondIds]);
    expect([...union].sort()).toEqual([alphaRenewal.id, gammaAlpha.id].sort());
  });

  it('SEARCH-7) audit — the q value is recorded in metadata.filter.q', async () => {
    const REASON = 'search audit q snapshot verification — ' + randomUUID();
    const q = `${RUN}beta`;
    await svc.list(principal(), REASON, { limit: 5, q });
    const rows = await ourAuditRows();
    const ours = rows.filter((r) => r.reason === REASON);
    expect(ours.length).toBe(1);
    const md = ours[0]!.metadata as { filter?: { q?: string | null } };
    expect(md.filter?.q).toBe(q);
  });
});
