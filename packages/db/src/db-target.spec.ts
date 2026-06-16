import { describe, expect, it } from 'vitest';

import {
  DB_TARGETS,
  DEFAULT_DB_TARGET,
  isDbTarget,
  resolveDbTarget,
  type DbTargetEnv,
} from './db-target';

const NEON_APP = 'postgresql://u:p@db-pooler.neon.tech/main';
const NEON_PROVIDER = 'postgresql://owner:p@db-pooler.neon.tech/main';
const NEON_DIRECT = 'postgresql://u:p@db.neon.tech/main';
const LOCAL = 'postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable';

describe('resolveDbTarget — target registry', () => {
  it('defaults to neon when DB_TARGET is unset', () => {
    const r = resolveDbTarget({ DATABASE_URL: NEON_APP });
    expect(r.target).toBe('neon');
    expect(DEFAULT_DB_TARGET).toBe('neon');
  });

  it('neon: maps app / provider / migrate URLs with the documented fallbacks', () => {
    const r = resolveDbTarget({
      DB_TARGET: 'neon',
      DATABASE_URL: NEON_APP,
      PROVIDER_DATABASE_URL: NEON_PROVIDER,
      DATABASE_MIGRATE_URL: NEON_DIRECT,
    });
    expect(r).toEqual({
      target: 'neon',
      appUrl: NEON_APP,
      providerUrl: NEON_PROVIDER,
      migrateUrl: NEON_DIRECT,
      pooled: true,
      migrateDirect: true,
    });
  });

  it('neon: provider + migrate fall back to DATABASE_URL when their own vars are unset', () => {
    const r = resolveDbTarget({ DATABASE_URL: NEON_APP });
    expect(r.providerUrl).toBe(NEON_APP);
    expect(r.migrateUrl).toBe(NEON_APP);
    // honesty: the fallback is the POOLER, so migrate is NOT direct.
    expect(r.migrateDirect).toBe(false);
  });

  it('neon: throws when DATABASE_URL is missing', () => {
    expect(() => resolveDbTarget({ DB_TARGET: 'neon' })).toThrow(/requires DATABASE_URL/);
  });

  it('local: every role + the migrator use the single local URL, not pooled', () => {
    const r = resolveDbTarget({ DB_TARGET: 'local', LOCAL_DATABASE_URL: LOCAL });
    expect(r).toEqual({
      target: 'local',
      appUrl: LOCAL,
      providerUrl: LOCAL,
      migrateUrl: LOCAL,
      pooled: false,
      migrateDirect: true,
    });
  });

  it('local: ignores Neon vars entirely (no leakage across targets)', () => {
    const r = resolveDbTarget({
      DB_TARGET: 'local',
      LOCAL_DATABASE_URL: LOCAL,
      DATABASE_URL: NEON_APP,
      PROVIDER_DATABASE_URL: NEON_PROVIDER,
    });
    expect(r.appUrl).toBe(LOCAL);
    expect(r.providerUrl).toBe(LOCAL);
  });

  it('local: throws an actionable error when LOCAL_DATABASE_URL is missing', () => {
    expect(() => resolveDbTarget({ DB_TARGET: 'local', DATABASE_URL: NEON_APP })).toThrow(
      /DB_TARGET=local requires LOCAL_DATABASE_URL/,
    );
  });

  it('throws on an unknown target, naming the valid set', () => {
    expect(() =>
      resolveDbTarget({ DB_TARGET: 'supabase', DATABASE_URL: NEON_APP } as DbTargetEnv),
    ).toThrow(/Unknown DB_TARGET "supabase".*neon, local/s);
  });
});

describe('isDbTarget / DB_TARGETS', () => {
  it('recognises every declared target and rejects others', () => {
    for (const t of DB_TARGETS) expect(isDbTarget(t)).toBe(true);
    expect(isDbTarget('mysql')).toBe(false);
    expect(isDbTarget('')).toBe(false);
  });
});
