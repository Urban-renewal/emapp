/**
 * Phase 4 unit proof — storage helpers (deterministic, zero-infra).
 * Pins: factory FAILS FAST in production (no silent Fake); the object key
 * is server-generated, org-partitioned and unguessable; the download
 * filename is sanitised (no header-injection / path / quotes).
 */
import { FakeStorageProvider } from '@emapp/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  newDocumentKey,
  resetStorageProviderForTests,
  safeDownloadFilename,
  storageProviderFactory,
} from './storage';

describe('Phase 4 · storage helpers', () => {
  const prev = process.env['NODE_ENV'];
  // v7: the factory exercises three branches (R2 / Fake / fail) based on
  // env. To test the Fake/fail branches we must clear any R2_* secrets
  // Infisical injected at process start — otherwise the factory
  // correctly returns R2StorageProvider and the Fake-branch assertion
  // is meaningless. We snapshot + restore so we don't leak into other
  // specs sharing the same vitest worker.
  //
  // Note: @emapp/db's `env` (T3-env) reads process.env at import time
  // and freezes the object. By the time these tests run, `env` is
  // already populated — but `r2EnvIsComplete(env)` re-reads the same
  // frozen object on every call, so deleting from process.env doesn't
  // help. Instead we mutate `env` itself (it's a plain object, not a
  // Proxy in T3) via a small helper that snapshots+restores.
  const r2Keys = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT'] as const;
  const envSnapshot: Partial<Record<(typeof r2Keys)[number], string | undefined>> = {};

  // v7 HIGH (factory singleton): the provider is now memoized — without
  // a reset between cases, a Fake constructed in case-N persists into
  // case-N+1 and masks env-flip behaviour.
  beforeEach(async () => {
    resetStorageProviderForTests();
    const { env } = (await import('@emapp/db')) as unknown as {
      env: Record<string, string | undefined>;
    };
    for (const k of r2Keys) {
      envSnapshot[k] = env[k];
      delete env[k];
    }
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = prev;
    resetStorageProviderForTests();
    const { env } = (await import('@emapp/db')) as unknown as {
      env: Record<string, string | undefined>;
    };
    for (const k of r2Keys) {
      if (envSnapshot[k] === undefined) delete env[k];
      else env[k] = envSnapshot[k];
    }
  });

  it('factory returns Fake outside prod when R2 env absent; FAILS FAST in production', async () => {
    const p = storageProviderFactory();
    expect(p).toBeInstanceOf(FakeStorageProvider);
    process.env['NODE_ENV'] = 'production';
    // Drop the dev singleton so the next call re-evaluates against the
    // new NODE_ENV.
    resetStorageProviderForTests();
    expect(() => storageProviderFactory()).toThrowError(/refusing to boot/i);
  });

  it('factory is memoized — repeated calls return the SAME instance (v7 HIGH)', () => {
    const a = storageProviderFactory();
    const b = storageProviderFactory();
    const c = storageProviderFactory();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('newDocumentKey: org-partitioned, unguessable, unique', () => {
    const org = '11111111-1111-1111-1111-111111111111';
    const k1 = newDocumentKey(org);
    const k2 = newDocumentKey(org);
    expect(k1).toMatch(/^org\/11111111-1111-1111-1111-111111111111\/doc\/[0-9a-f-]{36}$/);
    expect(k1).not.toBe(k2); // random uuid → not predictable/sequential
  });

  it('FakeStorageProvider.head() returns null (no real bytes to attest)', async () => {
    // D.28 R1/R2 interface prep — the finalize integrity gate calls
    // head() and treats null as "no storage attestation; layer-1 client
    // check stands alone". When R2 lands, this same call site gets real
    // contentLength + sha256 → true tamper evidence, no code change.
    const p = new FakeStorageProvider();
    expect(await p.head('any/key')).toBeNull();
  });

  it('safeDownloadFilename strips control/quote/path; falls back', () => {
    expect(safeDownloadFilename('חוזה.pdf')).toBe('חוזה.pdf');
    expect(safeDownloadFilename('a"b\\c/d.pdf')).toBe('abcd.pdf');
    expect(safeDownloadFilename('x\r\ny.pdf')).toBe('xy.pdf');
    expect(safeDownloadFilename('   ')).toBe('document');
    expect(safeDownloadFilename('"/\\')).toBe('document');
    expect(safeDownloadFilename('a'.repeat(500)).length).toBe(200);
  });
});
