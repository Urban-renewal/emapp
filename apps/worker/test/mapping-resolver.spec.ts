/**
 * D.34 Layer-strategy seam — IMappingResolver contract tests.
 *
 * Pure unit tests (no DB, no streams). Covers the chain semantics
 * + the LegacyAliasResolver wrapper so Phase 7's TemplateResolver
 * and AgentResolver can be added by composition without touching
 * the handler.
 *
 * Pinned invariants:
 *   1. LegacyAliasResolver returns 'resolved' for known-alias headers
 *   2. LegacyAliasResolver returns 'unknown' for incomplete mapping
 *      (recoverable — Layer 2 / Layer 3 may resolve)
 *   3. LegacyAliasResolver returns 'reject' for duplicate aliases
 *      (NOT recoverable — fail loud)
 *   4. MappingResolverChain returns the first non-'unknown' result
 *   5. MappingResolverChain returns 'unknown' iff every link did
 *   6. Order matters: an earlier 'resolved' wins over a later one
 *   7. A 'reject' from any link halts the chain (later resolvers
 *      DO NOT get to override it)
 *   8. Resolved result carries the source tag for audit / observability
 */
import { describe, expect, it } from 'vitest';

import {
  LegacyAliasResolver,
  MappingResolverChain,
  type IMappingResolver,
  type ResolveResult,
} from '../src/mapping/mapping-resolver';

/** A stub resolver that always returns the given result. Useful for
 *  chain composition tests without spinning up real strategies. */
function stub(name: string, result: ResolveResult): IMappingResolver {
  return {
    name,
    async resolve() {
      return result;
    },
  };
}

const VALID_HEADERS = ['national_id', 'phone', 'name', 'apartment', 'address'];

describe('D.34 — IMappingResolver chain', () => {
  it('1) LegacyAliasResolver — known-alias headers → resolved+legacy', async () => {
    const r = new LegacyAliasResolver();
    const out = await r.resolve(VALID_HEADERS);
    expect(out.kind).toBe('resolved');
    if (out.kind === 'resolved') {
      expect(out.source).toBe('legacy');
      expect(out.mapping.columns).toMatchObject({
        national_id: 0,
        phone: 1,
        name: 2,
        apartment_number: 3,
        building_address: 4,
      });
    }
  });

  it('2) LegacyAliasResolver — incomplete mapping → unknown (recoverable)', async () => {
    const r = new LegacyAliasResolver();
    // Missing apartment + address.
    const out = await r.resolve(['national_id', 'phone', 'name']);
    expect(out.kind).toBe('unknown');
  });

  it('3) LegacyAliasResolver — duplicate alias → reject (not recoverable)', async () => {
    const r = new LegacyAliasResolver();
    // 'national_id' and 'ת.ז.' both map to the same canonical.
    const out = await r.resolve(['national_id', 'ת.ז.', 'phone', 'name', 'apartment', 'address']);
    expect(out.kind).toBe('reject');
    if (out.kind === 'reject') {
      expect(out.reason).toContain('duplicate_alias');
    }
  });

  it('4) MappingResolverChain — first non-unknown wins', async () => {
    const headers = ['anything'];
    const chain = new MappingResolverChain([
      stub('a', { kind: 'unknown' }),
      stub('b', {
        kind: 'resolved',
        mapping: { columns: { national_id: 0 }, unmapped: [], ambiguous: [] },
        source: 'template',
      }),
      stub('c', {
        kind: 'resolved',
        mapping: { columns: { national_id: 9 }, unmapped: [], ambiguous: [] },
        source: 'agent',
      }),
    ]);
    const out = await chain.resolve(headers);
    expect(out.kind).toBe('resolved');
    if (out.kind === 'resolved') {
      // First non-unknown (b) wins; c never runs.
      expect(out.source).toBe('template');
      expect(out.mapping.columns.national_id).toBe(0);
    }
  });

  it('5) MappingResolverChain — all unknown → final unknown', async () => {
    const chain = new MappingResolverChain([
      stub('a', { kind: 'unknown' }),
      stub('b', { kind: 'unknown' }),
      stub('c', { kind: 'unknown' }),
    ]);
    const out = await chain.resolve(['x']);
    expect(out.kind).toBe('unknown');
  });

  it('6) MappingResolverChain — reject from any link halts the chain', async () => {
    let cRan = false;
    const chain = new MappingResolverChain([
      stub('a', { kind: 'unknown' }),
      stub('b', { kind: 'reject', reason: 'malformed-input' }),
      {
        name: 'c',
        async resolve() {
          cRan = true;
          return {
            kind: 'resolved',
            mapping: { columns: { national_id: 0 }, unmapped: [], ambiguous: [] },
            source: 'agent',
          };
        },
      },
    ]);
    const out = await chain.resolve(['x']);
    expect(out.kind).toBe('reject');
    expect(cRan).toBe(false);
  });

  it('7) MappingResolverChain — first resolved beats any later resolved', async () => {
    const chain = new MappingResolverChain([
      stub('legacy', {
        kind: 'resolved',
        mapping: { columns: { national_id: 0 }, unmapped: [], ambiguous: [] },
        source: 'legacy',
      }),
      stub('agent', {
        kind: 'resolved',
        mapping: { columns: { national_id: 99 }, unmapped: [], ambiguous: [] },
        source: 'agent',
      }),
    ]);
    const out = await chain.resolve(['x']);
    if (out.kind === 'resolved') {
      expect(out.source).toBe('legacy');
      expect(out.mapping.columns.national_id).toBe(0);
    }
  });

  it('8) production chain composition — Legacy alone, the default', async () => {
    // The handler's default constructor is `new LegacyAliasResolver()`.
    // Production main.ts MAY add Layer 2 + 3 in front of L1; the
    // contract is that L1 alone is sufficient for ~80% of files.
    const chain = new MappingResolverChain([new LegacyAliasResolver()]);
    const ok = await chain.resolve(VALID_HEADERS);
    expect(ok.kind).toBe('resolved');
    const unknown = await chain.resolve(['unknown_a', 'unknown_b']);
    expect(unknown.kind).toBe('unknown');
  });
});
