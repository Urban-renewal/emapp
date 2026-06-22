/**
 * SEC-H1 — the shared external-party authz resolver: allow/deny MATRIX.
 *
 * This is the read-consumer the audit (blocker #8) said `external_shares` was
 * missing. The pure core (`decideExternalPartyAccess` + `isDocInShareScope`) is
 * exhaustively unit-tested here, independent of the DB — the DB-backed wiring
 * (`ExternalSharesService.resolveDocumentAccess`) + its RLS cross-org isolation
 * are covered by the DB-backed spec (external-shares.spec.ts, Infisical/CI).
 *
 * The matrix proves every gate FAILS CLOSED:
 *   expired → deny · revoked → deny · out-of-scope → deny ·
 *   sensitive-without-allow_sensitive → deny (structural, before OTP) ·
 *   sensitive-with-allow_sensitive-but-no-OTP → deny · valid → allow.
 */
import type { ExternalSharePermissions } from '@emapp/db';
import { ExternalPartyAccessQuery } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  decideExternalPartyAccess,
  isDocInShareScope,
  type ResolvableDocument,
  type ResolvableShare,
} from './external-party-authz';

const NOW = new Date('2026-06-22T12:00:00.000Z');
const FUTURE = new Date('2026-12-31T00:00:00.000Z');
const PAST = new Date('2026-01-01T00:00:00.000Z');

const FULL_DOWNLOAD_PERMS: ExternalSharePermissions = {
  overview: { on: true },
  documents: { on: true, actions: { download: true } },
  signatures: { on: true },
};

/** A maximally-permissive ACTIVE grant (download on, sensitive allowed, no OTP
 *  required, not expired, not revoked) — overridden per test to flip ONE axis. */
function share(over: Partial<ResolvableShare> = {}): ResolvableShare {
  return {
    permissions: FULL_DOWNLOAD_PERMS,
    allowSensitive: true,
    otpRequired: false,
    expiresAt: FUTURE,
    revokedAt: null,
    watermarkSubject: null,
    ...over,
  };
}

/** A servable, in-scope, NON-sensitive plain doc — overridden per test. */
function doc(over: Partial<ResolvableDocument> = {}): ResolvableDocument {
  return { sensitive: false, bytesEncrypted: false, inScope: true, servable: true, ...over };
}

const ctx = (otpVerified = false) => ({ now: NOW, otpVerified });

describe('decideExternalPartyAccess — allow/deny matrix (SEC-H1)', () => {
  it('VALID active grant + in-scope servable non-sensitive doc → ALLOW', () => {
    const d = decideExternalPartyAccess(share(), doc(), ctx());
    expect(d.allow).toBe(true);
    if (d.allow) {
      expect(d.constraints.requiresDecryptStream).toBe(false);
      expect(d.constraints.watermarkSubject).toBeNull();
    }
  });

  it('REVOKED grant → deny (share_revoked), even if everything else is valid', () => {
    const d = decideExternalPartyAccess(share({ revokedAt: PAST }), doc(), ctx());
    expect(d).toEqual({ allow: false, reason: 'share_revoked' });
  });

  it('EXPIRED grant (expiresAt <= now) → deny (share_expired) — enforced every request', () => {
    const d = decideExternalPartyAccess(share({ expiresAt: PAST }), doc(), ctx());
    expect(d).toEqual({ allow: false, reason: 'share_expired' });
  });

  it('expiresAt EXACTLY now → deny (boundary is inclusive, fail-closed)', () => {
    const d = decideExternalPartyAccess(share({ expiresAt: new Date(NOW) }), doc(), ctx());
    expect(d).toEqual({ allow: false, reason: 'share_expired' });
  });

  it('null expiresAt → not expired (non-expiring grant) → ALLOW', () => {
    expect(decideExternalPartyAccess(share({ expiresAt: null }), doc(), ctx()).allow).toBe(true);
  });

  it('documents resource OFF → deny (documents_not_granted)', () => {
    const d = decideExternalPartyAccess(
      share({
        permissions: {
          ...FULL_DOWNLOAD_PERMS,
          documents: { on: false, actions: { download: false } },
        },
      }),
      doc(),
      ctx(),
    );
    expect(d).toEqual({ allow: false, reason: 'documents_not_granted' });
  });

  it('download capability OFF → deny (download_not_granted)', () => {
    const d = decideExternalPartyAccess(
      share({
        permissions: {
          ...FULL_DOWNLOAD_PERMS,
          documents: { on: true, actions: { download: false } },
        },
      }),
      doc(),
      ctx(),
    );
    expect(d).toEqual({ allow: false, reason: 'download_not_granted' });
  });

  it('OUT-OF-SCOPE doc → deny (out_of_scope)', () => {
    const d = decideExternalPartyAccess(share(), doc({ inScope: false }), ctx());
    expect(d).toEqual({ allow: false, reason: 'out_of_scope' });
  });

  it('SENSITIVE doc + share does NOT allow_sensitive → deny (sensitive_not_allowed), even WITH OTP', () => {
    const d = decideExternalPartyAccess(
      share({ allowSensitive: false }),
      doc({ sensitive: true, bytesEncrypted: true }),
      ctx(true), // OTP verified — must STILL deny (structural exclusion)
    );
    expect(d).toEqual({ allow: false, reason: 'sensitive_not_allowed' });
  });

  it('SENSITIVE doc + allow_sensitive but NO OTP verified → deny (otp_required)', () => {
    const d = decideExternalPartyAccess(
      share({ allowSensitive: true }),
      doc({ sensitive: true, bytesEncrypted: true }),
      ctx(false),
    );
    expect(d).toEqual({ allow: false, reason: 'otp_required' });
  });

  it('SENSITIVE doc + allow_sensitive + OTP verified → ALLOW, requiresDecryptStream=true', () => {
    const d = decideExternalPartyAccess(
      share({ allowSensitive: true, watermarkSubject: 'דייר #12' }),
      doc({ sensitive: true, bytesEncrypted: true }),
      ctx(true),
    );
    expect(d.allow).toBe(true);
    if (d.allow) {
      expect(d.constraints.requiresDecryptStream).toBe(true);
      expect(d.constraints.watermarkSubject).toBe('דייר #12');
    }
  });

  it('share marks otp_required → even a NON-sensitive doc needs OTP', () => {
    const denied = decideExternalPartyAccess(share({ otpRequired: true }), doc(), ctx(false));
    expect(denied).toEqual({ allow: false, reason: 'otp_required' });
    const allowed = decideExternalPartyAccess(share({ otpRequired: true }), doc(), ctx(true));
    expect(allowed.allow).toBe(true);
  });

  it('NON-servable doc (ghost / infected / archived) → deny (document_not_servable)', () => {
    const d = decideExternalPartyAccess(share(), doc({ servable: false }), ctx());
    expect(d).toEqual({ allow: false, reason: 'document_not_servable' });
  });

  it('NO deny reason ever carries PII / ids (closed coarse-code enum)', () => {
    const reasons = [
      decideExternalPartyAccess(share({ revokedAt: PAST }), doc(), ctx()),
      decideExternalPartyAccess(share({ expiresAt: PAST }), doc(), ctx()),
      decideExternalPartyAccess(share(), doc({ inScope: false }), ctx()),
      decideExternalPartyAccess(share({ allowSensitive: false }), doc({ sensitive: true }), ctx()),
    ];
    const allowed = new Set([
      'share_revoked',
      'share_expired',
      'documents_not_granted',
      'download_not_granted',
      'out_of_scope',
      'sensitive_not_allowed',
      'otp_required',
      'document_not_servable',
    ]);
    for (const r of reasons) {
      expect(r.allow).toBe(false);
      if (!r.allow) expect(allowed.has(r.reason)).toBe(true);
    }
  });

  it('lifecycle gates win over permission/scope (revoked checked FIRST)', () => {
    // A revoked grant with documents OFF + out-of-scope doc still reports the
    // STRONGEST (lifecycle) reason — confirms the fail-closed ordering.
    const d = decideExternalPartyAccess(
      share({
        revokedAt: PAST,
        permissions: {
          ...FULL_DOWNLOAD_PERMS,
          documents: { on: false, actions: { download: false } },
        },
      }),
      doc({ inScope: false }),
      ctx(),
    );
    expect(d).toEqual({ allow: false, reason: 'share_revoked' });
  });
});

describe('ExternalPartyAccessQuery.otpVerified — fail-closed coercion (SEC-H1)', () => {
  // REGRESSION: z.coerce.boolean() coerces the STRING 'false' to `true` — a
  // fail-OPEN that would let ?otpVerified=false clear the OTP gate. ONLY the
  // literal 'true' yields true; everything else (incl. 'false', '0', absent) is
  // fail-closed false.
  it('?otpVerified=false → false (NOT coerced true)', () => {
    expect(ExternalPartyAccessQuery.parse({ otpVerified: 'false' }).otpVerified).toBe(false);
  });
  it('absent → false (fail-closed default)', () => {
    expect(ExternalPartyAccessQuery.parse({}).otpVerified).toBe(false);
  });
  it('?otpVerified=true → true (the ONLY truthy value)', () => {
    expect(ExternalPartyAccessQuery.parse({ otpVerified: 'true' }).otpVerified).toBe(true);
  });
  it('a non-enum value (e.g. "1") is REJECTED (no silent truthy coercion)', () => {
    expect(ExternalPartyAccessQuery.safeParse({ otpVerified: '1' }).success).toBe(false);
  });
});

describe('isDocInShareScope — set-based membership matrix (SEC-H1)', () => {
  const P = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  const A = '33333333-3333-3333-3333-333333333333';
  const OTHER = '99999999-9999-9999-9999-999999999999';

  it('project scope: doc whose projectId ∈ scopeIds → in scope', () => {
    expect(isDocInShareScope('project', [P], { projectId: P, buildingId: B, apartmentId: A })).toBe(
      true,
    );
  });

  it('project scope: doc of a DIFFERENT project → out of scope', () => {
    expect(
      isDocInShareScope('project', [OTHER], { projectId: P, buildingId: B, apartmentId: A }),
    ).toBe(false);
  });

  it('building scope: doc whose apartment building ∈ scopeIds → in scope', () => {
    expect(
      isDocInShareScope('building', [B], { projectId: P, buildingId: B, apartmentId: A }),
    ).toBe(true);
  });

  it('building scope: a PROJECT-level doc (no apartment → no building) → out of scope', () => {
    expect(
      isDocInShareScope('building', [B], { projectId: P, buildingId: null, apartmentId: null }),
    ).toBe(false);
  });

  it('apartment scope: doc whose apartmentId ∈ scopeIds → in scope', () => {
    expect(
      isDocInShareScope('apartment', [A], { projectId: P, buildingId: B, apartmentId: A }),
    ).toBe(true);
  });

  it('apartment scope: a project-level doc (apartmentId null) → out of scope (fail-closed)', () => {
    expect(
      isDocInShareScope('apartment', [A], { projectId: P, buildingId: B, apartmentId: null }),
    ).toBe(false);
  });
});
