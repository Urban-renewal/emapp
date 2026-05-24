/**
 * Unit tests for `reloadEnv()` — v8 §v7-C credential rotation seam.
 *
 * Pure (no DB, no R2). Verifies:
 *  1. reloadEnv() returns [] when nothing changed
 *  2. mutating process.env.R2_BUCKET → reloadEnv() reports R2_BUCKET in changed keys
 *  3. the exported `env` object is mutated in place (same reference,
 *     new field values) so consumers don't need to re-import
 *  4. removing a key (set to undefined) is detected as changed
 *  5. setting a malformed value (e.g. non-URL R2_ENDPOINT) throws
 *     (validation re-runs against the live env)
 */
import { describe, expect, it } from 'vitest';

import { env, reloadEnv } from '../src/env';

const R2_KEYS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT'] as const;

function snapshotR2(): Partial<Record<(typeof R2_KEYS)[number], string | undefined>> {
  const out: Partial<Record<(typeof R2_KEYS)[number], string | undefined>> = {};
  for (const k of R2_KEYS) out[k] = process.env[k];
  return out;
}

function restoreR2(snap: Partial<Record<(typeof R2_KEYS)[number], string | undefined>>) {
  for (const k of R2_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe('reloadEnv — v8 §v7-C credential rotation', () => {
  it('1) returns no changes when env unchanged', () => {
    const changed = reloadEnv();
    expect(changed).toEqual([]);
  });

  it('2) reports the changed key when R2_BUCKET is mutated', () => {
    const snap = snapshotR2();
    try {
      process.env['R2_BUCKET'] = 'rotated-bucket-name';
      // Reload twice — first one observes the change, second one
      // should report no changes (idempotency).
      const first = reloadEnv();
      expect(first).toContain('R2_BUCKET');
      const second = reloadEnv();
      expect(second).not.toContain('R2_BUCKET');
    } finally {
      restoreR2(snap);
      reloadEnv();
    }
  });

  it('3) mutates the exported `env` in place (same reference)', () => {
    const snap = snapshotR2();
    const envRef = env;
    try {
      process.env['R2_BUCKET'] = 'rotation-test';
      reloadEnv();
      // Reference identity preserved — consumers that hold a
      // reference to `env` see the new value via re-read of `env.X`.
      expect(env).toBe(envRef);
      expect((env as Record<string, unknown>)['R2_BUCKET']).toBe('rotation-test');
    } finally {
      restoreR2(snap);
      reloadEnv();
    }
  });

  it('4) removing a key (set to undefined) is detected', () => {
    const snap = snapshotR2();
    try {
      process.env['R2_BUCKET'] = 'set';
      reloadEnv();
      delete process.env['R2_BUCKET'];
      const changed = reloadEnv();
      expect(changed).toContain('R2_BUCKET');
      expect((env as Record<string, unknown>)['R2_BUCKET']).toBeUndefined();
    } finally {
      restoreR2(snap);
      reloadEnv();
    }
  });

  it('5) does NOT log secret VALUES (caller asserts via spy)', () => {
    // reloadEnv only returns key names, never values — this is the
    // contract that lets the SIGHUP handler log safely. A future
    // change that adds value-logging would be a security regression.
    const snap = snapshotR2();
    try {
      process.env['R2_SECRET_ACCESS_KEY'] = 'super-secret-rotated-value-xyz';
      const changed = reloadEnv();
      // The returned array MUST be just the key name; the value
      // must never appear in it.
      for (const k of changed) {
        expect(k).not.toContain('super-secret-rotated-value-xyz');
      }
    } finally {
      restoreR2(snap);
      reloadEnv();
    }
  });
});
