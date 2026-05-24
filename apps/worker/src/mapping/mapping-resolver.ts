/**
 * IMappingResolver — D.34 Layer-strategy seam.
 *
 * The worker doesn't know (and shouldn't know) WHERE a header→canonical
 * mapping comes from. It only knows:
 *   1. give me headers
 *   2. tell me a resolved ColumnMapping, OR
 *   3. tell me you can't (so the row goes to awaiting_mapping)
 *
 * Strategies (resolved in order; first hit wins):
 *
 *   L1: `LegacyAliasResolver` — the deterministic alias registry from
 *       Phase 6 S4. Pure function over headers. ~80% of common files.
 *       Implemented (this file).
 *
 *   L2: `TemplateResolver` — looks up mapping_templates by fingerprint
 *       (sha256 of normalised headers sorted, see resolveMapping line
 *       226 — "When customizable templates land, the registry pattern
 *       stays — we add a `mapping_templates` table"). Reads must
 *       respect: only `approved_by IS NOT NULL` AND `archived_at IS
 *       NULL`. NOT yet implemented — depends on S8 wizard creating
 *       templates first.
 *
 *   L3: `AgentResolver` — Phase 7+. Sends ONLY headers + canonical
 *       field semantic descriptions to an LLM; receives a proposed
 *       mapping with confidence. NOT auto-applied — manager approves
 *       via the wizard, which inserts a Layer-2 row with source='agent'.
 *
 * The handler today uses `LegacyAliasResolver` as its only injected
 * resolver. Tomorrow, `main.ts` composes a chain of all three. The
 * IMappingResolver contract is fixed so the chain composition stays
 * additive (Open/Closed Principle).
 */
import { MappingError, resolveMapping, type ColumnMapping } from './mapping';

/** Result of a resolver attempt. */
export type ResolveResult =
  | { kind: 'resolved'; mapping: ColumnMapping; source: 'legacy' | 'template' | 'agent' }
  /** Resolver doesn't know; caller should try the next strategy. */
  | { kind: 'unknown' }
  /** Resolver decisively says this file is bad (e.g. duplicate column
   *  alias to two different canonicals). Different from `unknown` —
   *  no later strategy will fix it; the worker should fail-loud. */
  | { kind: 'reject'; reason: string };

/** A strategy in the L1/L2/L3 chain. Pure on inputs; no internal state.
 *  Implementations MAY hold a TenantTx (Layer 2 needs DB access). */
export interface IMappingResolver {
  /** Strategy name for logging / audit / observability. */
  readonly name: string;
  /** Try to resolve. Return 'unknown' to defer to the next strategy. */
  resolve(headers: string[]): Promise<ResolveResult>;
}

/** L1 — wraps the deterministic `resolveMapping` from mapping.ts.
 *  This is what the handler USED to call directly; now it goes through
 *  the resolver contract so L2 + L3 can plug in front of / behind it. */
export class LegacyAliasResolver implements IMappingResolver {
  readonly name = 'legacy-alias';
  async resolve(headers: string[]): Promise<ResolveResult> {
    try {
      const mapping = resolveMapping(headers);
      return { kind: 'resolved', mapping, source: 'legacy' };
    } catch (e) {
      if (e instanceof MappingError && e.code === 'mapping_incomplete') {
        // Recoverable — Layer 2 (saved template) or Layer 3 (agent) may
        // still resolve it. Tell the chain to keep trying.
        return { kind: 'unknown' };
      }
      if (e instanceof MappingError && e.code === 'mapping_duplicate') {
        // NOT recoverable by any later layer — duplicate aliases in the
        // file itself is a malformed input. Reject loud.
        return { kind: 'reject', reason: `duplicate_alias: ${e.fields.join(',')}` };
      }
      throw e;
    }
  }
}

/** Compose a chain. Tries each in order; first 'resolved' or 'reject'
 *  wins. If all return 'unknown', the final result is 'unknown' — the
 *  handler interprets this as "send to awaiting_mapping state". */
export class MappingResolverChain implements IMappingResolver {
  readonly name = 'chain';
  constructor(private readonly resolvers: readonly IMappingResolver[]) {}
  async resolve(headers: string[]): Promise<ResolveResult> {
    for (const r of this.resolvers) {
      const result = await r.resolve(headers);
      if (result.kind !== 'unknown') {
        return result;
      }
    }
    return { kind: 'unknown' };
  }
}
