/**
 * D.46 — contractor share default-permission compliance (pure unit spec).
 *
 * The locked D.46 contractor profile: a NEW share must, by default, deny
 * owners/PII entirely and expose documents only by manager selection, while
 * allowing project overview + AGGREGATE signature progress. These are pure
 * functions (no DB) — the contractor read-tier that consumes them is
 * deferred, but the default + the perms-driven resolvers are the security
 * contract that tier will be built on.
 */
import { canDownloadDocuments, defaultSharePermissions, signatureScopeForShare } from '@emapp/db';
import { describe, expect, it } from 'vitest';

describe('D.46 — default contractor share permissions', () => {
  const def = defaultSharePermissions();

  it('documents are manager-SELECTED (OFF by default)', () => {
    expect(def.documents.on).toBe(false);
    expect(canDownloadDocuments(def)).toBe(false);
  });

  it('project overview + signature progress are ON by default', () => {
    expect(def.overview.on).toBe(true);
    expect(def.signatures.on).toBe(true);
  });

  // A3 (L4): owners/PII (`tenants`), `notes`, `team`, and document `upload`
  // were removed as DEAD keys — the contractor read-path never consulted
  // them, so a default that "denies" them is now structurally impossible
  // (the keys don't exist). Owner-PII OFF is enforced structurally instead:
  // there is no owners endpoint in the contractor tier at all.
  it('the granted surface is exactly overview / documents / signatures', () => {
    expect(Object.keys(def).sort()).toEqual(['documents', 'overview', 'signatures']);
  });
});

describe('D.46 — signature progress is AGGREGATE-only (structural)', () => {
  it('a share with signatures on resolves to "aggregate" (never "individual")', () => {
    const scope = signatureScopeForShare(defaultSharePermissions());
    expect(scope).toBe('aggregate');
    // Type-level guarantee: the resolver can only ever be 'none' | 'aggregate'.
    const scopes: Array<'none' | 'aggregate'> = [scope];
    expect(scopes).not.toContain('individual');
  });

  it('a share with signatures off resolves to "none"', () => {
    const off = { ...defaultSharePermissions(), signatures: { on: false } };
    expect(signatureScopeForShare(off)).toBe('none');
  });
});
