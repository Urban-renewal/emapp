/**
 * V10-S1 closure spec — `GET /api/v1/provider/me` (Provider Admin
 * self-identity).
 *
 * Service-level: instantiates `ProviderAuthService.getProfile()`
 * directly against the real Neon dev DB (same pattern as
 * provider-tenants.spec.ts / provider-system-health.spec.ts). The
 * controller is a thin null-to-401 mapper — covered with a separate
 * inline describe block at the bottom.
 *
 * 5-axis coverage (per docs/TEST-COVERAGE-MATRIX-V2 §6):
 *   א. פונקציונליות   — happy path; disabled; missing; corrupted role
 *   ב. אבטחה          — column allowlist (no PII / secrets leak);
 *                       anti-enum (same null → same 401 code)
 *   ג. ניהול שגיאות   — null mapped to UnauthorizedException; D.16
 *                       envelope { error: { code: 'invalid_token' } }
 *   ד. זמן ריצה       — single SELECT, no withProvider ceremony
 *                       (asserted by counting audit rows post-call —
 *                       MUST be zero)
 *   ה. SOLID/concur   — 5 concurrent calls all return the same shape;
 *                       no shared mutable state.
 *
 * Test IDs:
 *   T10-S1-1   happy path — existing active provider → ProviderProfile
 *   T10-S1-2   security — return shape contains EXACTLY the allowlist
 *              keys (no passwordHash / mfaSecretEncrypted / recoveryCodesHash /
 *              failedLoginCount / lockedUntil / lastLoginAt / disabledAt leak)
 *   T10-S1-3   disabled provider (disabledAt set) → null
 *   T10-S1-4   missing provider (random UUID) → null
 *   T10-S1-5   corrupted role (DB role = 'not_in_DB_TO_JWT_ROLE') → null
 *   T10-S1-6   role mapping — DB role 'admin' → JWT role 'provider_admin'
 *   T10-S1-7   runtime — getProfile() does NOT write an audit row
 *              (identity check, not cross-tenant action)
 *   T10-S1-8   concurrency — 5 parallel calls return identical profiles
 *   T10-S1-9   controller — null → UnauthorizedException with D.16
 *              envelope { error: { code: 'invalid_token' } } (anti-enum)
 *   T10-S1-10  controller — happy path returns { data: profile }
 */
import { providerUsers } from '@emapp/db';
import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, providerPool } from '../../../../../../packages/db/src/client';
import {
  createTestProviderUser,
  type TestProviderUser,
} from '../../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../../packages/db/test/setup';

import { ProviderAuthService, type ProviderTokenPayload } from './provider-auth.service';
import { ProviderMeController } from './provider-me.controller';

let provider: TestProviderUser;
let svc: ProviderAuthService;
let auditStartMarker: Date;

beforeAll(async () => {
  await setupTestDatabase();
  provider = await createTestProviderUser();
  // JwtService is unused by getProfile() (no JWT minted on a self-
  // identity read), so passing `undefined as unknown as JwtService` is
  // safe — the service method we test never touches `this.jwt`. The
  // login + refresh paths use it, but their specs are elsewhere.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam, see comment above
  svc = new ProviderAuthService(undefined as any);
  auditStartMarker = new Date();
}, 60_000);

afterAll(() => {
  // Pools are shared singletons — global teardown handles them.
});

/** Audit-row count for the provider since this suite started. The
 *  /me path MUST NOT write any rows (T10-S1-7). */
async function ourAuditRowCount(): Promise<number> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM provider_audit_log
       WHERE provider_user_id = $1 AND started_at >= $2`,
      [provider.id, auditStartMarker.toISOString()],
    );
    return Number(r.rows[0]?.cnt ?? 0);
  } finally {
    client.release();
  }
}

describe('GET /provider/me — V10-S1 service integration', () => {
  it('T10-S1-1) happy path — existing active provider returns ProviderProfile', async () => {
    const profile = await svc.getProfile(provider.id);
    expect(profile).not.toBeNull();
    expect(profile!.id).toBe(provider.id);
    expect(profile!.email).toBe(provider.email);
    expect(profile!.name).toBe('Test Provider Admin');
    expect(profile!.role).toBe('provider_admin');
  });

  it('T10-S1-2) security — return shape contains EXACTLY the allowlist keys', async () => {
    const profile = await svc.getProfile(provider.id);
    expect(profile).not.toBeNull();
    const keys = Object.keys(profile!).sort();
    expect(keys).toEqual(['email', 'id', 'name', 'role']);
    // Defensive: explicitly assert no leaked internal columns are
    // present even if Object.keys ordering quirks hid them above.
    const dyn = profile as unknown as Record<string, unknown>;
    expect(dyn['passwordHash']).toBeUndefined();
    expect(dyn['mfaSecretEncrypted']).toBeUndefined();
    expect(dyn['recoveryCodesHash']).toBeUndefined();
    expect(dyn['failedLoginCount']).toBeUndefined();
    expect(dyn['lockedUntil']).toBeUndefined();
    expect(dyn['lastLoginAt']).toBeUndefined();
    expect(dyn['disabledAt']).toBeUndefined();
  });

  it('T10-S1-3) disabled provider (disabledAt set) → null (anti-enum same as missing)', async () => {
    const disabled = await createTestProviderUser();
    await db
      .update(providerUsers)
      .set({ disabledAt: new Date() })
      .where(eq(providerUsers.id, disabled.id));

    const profile = await svc.getProfile(disabled.id);
    expect(profile).toBeNull();
  });

  it('T10-S1-4) missing provider (random UUID) → null', async () => {
    const profile = await svc.getProfile('00000000-0000-0000-0000-000000000000');
    expect(profile).toBeNull();
  });

  it('T10-S1-5) corrupted role (DB role not in DB_TO_JWT_ROLE) → null (SA-3 defense)', async () => {
    const corrupted = await createTestProviderUser();
    await db
      .update(providerUsers)
      .set({ role: 'definitely_not_a_role' })
      .where(eq(providerUsers.id, corrupted.id));

    const profile = await svc.getProfile(corrupted.id);
    expect(profile).toBeNull();
  });

  it('T10-S1-6) role mapping — DB role "admin" maps to JWT role "provider_admin"', async () => {
    // Default factory creates `role: 'admin'` (the DB default). This
    // pins the SA-3 mapping contract from the lookup side.
    const profile = await svc.getProfile(provider.id);
    expect(profile?.role).toBe('provider_admin');
  });

  it('T10-S1-7) runtime — getProfile() writes ZERO audit rows', async () => {
    const before = await ourAuditRowCount();
    // 10 calls in case of any racy write.
    await Promise.all(Array.from({ length: 10 }, () => svc.getProfile(provider.id)));
    const after = await ourAuditRowCount();
    expect(after).toBe(before);
  });

  it('T10-S1-8) concurrency — 5 parallel calls return identical profiles', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => svc.getProfile(provider.id)));
    for (const r of results) {
      expect(r).not.toBeNull();
      expect(r!.id).toBe(provider.id);
      expect(r!.role).toBe('provider_admin');
    }
  });
});

describe('GET /provider/me — V10-S1 controller (null → 401 anti-enum)', () => {
  function makeReq(sub: string): { providerUser: ProviderTokenPayload } {
    return {
      providerUser: {
        sub,
        role: 'provider_admin',
        sid: 'fake-sid',
        type: 'provider_access',
      },
    };
  }

  it('T10-S1-9) null profile → UnauthorizedException with D.16 invalid_token envelope', async () => {
    const ctrl = new ProviderMeController(svc);
    expect.assertions(2);
    try {
      // Pass a random UUID — service returns null → controller throws.
      await ctrl.getMe(makeReq('00000000-0000-0000-0000-000000000000') as never);
    } catch (e) {
      expect(e).toBeInstanceOf(UnauthorizedException);
      const body = (e as UnauthorizedException).getResponse();
      expect(body).toEqual({ error: { code: 'invalid_token' } });
    }
  });

  it('T10-S1-10) happy path returns { data: ProviderProfile }', async () => {
    const ctrl = new ProviderMeController(svc);
    const out = await ctrl.getMe(makeReq(provider.id) as never);
    expect(out).toEqual({
      data: {
        id: provider.id,
        email: provider.email,
        name: 'Test Provider Admin',
        role: 'provider_admin',
      },
    });
  });
});
