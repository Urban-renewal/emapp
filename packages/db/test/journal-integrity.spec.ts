/**
 * Pins the migration-journal silent-skip guard (see
 * src/migrations/journal-integrity.ts). Two jobs:
 *
 *   1. LIVE assertion — the REAL `_journal.json` shipped in this repo is
 *      healthy (idx contiguous, tags unique, every .sql present, `when`
 *      strictly increasing modulo the one grandfathered historical inversion).
 *      This is the guard that fails a PR which hand-authors a too-low `when`.
 *
 *   2. TEETH — synthetic journals that VIOLATE each invariant must produce the
 *      matching violation, so a future hand can't neuter the guard into always
 *      returning []. A guard that can't fail is not a guard.
 *
 * Pure/static: no DB. (global-setup still migrates the test DB for the suite,
 * but nothing here touches a connection.)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkJournalIntegrity,
  findUnappliedMigrations,
  type Journal,
  type JournalEntry,
} from '../src/migrations/journal-integrity';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

function loadRealJournal(): Journal {
  const raw = readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8');
  return JSON.parse(raw) as Journal;
}

function entry(idx: number, tag: string, when: number): JournalEntry {
  return { idx, version: '7', when, tag, breakpoints: true };
}

const allFilesExist = () => true;

describe('journal-integrity — the real shipped journal', () => {
  it('1) real _journal.json passes every static invariant', () => {
    const journal = loadRealJournal();
    const violations = checkJournalIntegrity(journal, (tag) =>
      existsSync(join(MIGRATIONS_DIR, `${tag}.sql`)),
    );
    expect(violations).toEqual([]);
  });

  it('2) every real journal tag has its .sql file on disk', () => {
    const journal = loadRealJournal();
    const missing = journal.entries.filter(
      (e) => !existsSync(join(MIGRATIONS_DIR, `${e.tag}.sql`)),
    );
    expect(missing.map((e) => e.tag)).toEqual([]);
  });

  it('3) real journal idx values are 0..n-1 contiguous and ordered', () => {
    const journal = loadRealJournal();
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });
});

describe('journal-integrity — teeth (synthetic violations)', () => {
  it('4) a tip migration with when <= prior max → when_not_increasing', () => {
    const journal: Journal = {
      version: '7',
      dialect: 'postgresql',
      entries: [
        entry(0, '0000_a', 1000),
        entry(1, '0001_b', 2000),
        entry(2, '0002_c', 1500), // too low — would be silently skipped
      ],
    };
    const v = checkJournalIntegrity(journal, allFilesExist);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe('when_not_increasing');
    expect(v[0]?.tag).toBe('0002_c');
  });

  it('5) when equal to prior max (not strictly greater) → when_not_increasing', () => {
    const journal: Journal = {
      version: '7',
      dialect: 'postgresql',
      entries: [entry(0, '0000_a', 1000), entry(1, '0001_b', 1000)],
    };
    const v = checkJournalIntegrity(journal, allFilesExist);
    expect(v.map((x) => x.kind)).toContain('when_not_increasing');
  });

  it('6) a missing .sql file → missing_sql_file', () => {
    const journal: Journal = {
      version: '7',
      dialect: 'postgresql',
      entries: [entry(0, '0000_a', 1000), entry(1, '0001_b', 2000)],
    };
    const v = checkJournalIntegrity(journal, (tag) => tag !== '0001_b');
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe('missing_sql_file');
    expect(v[0]?.tag).toBe('0001_b');
  });

  it('7) a duplicate tag → duplicate_tag', () => {
    const journal: Journal = {
      version: '7',
      dialect: 'postgresql',
      entries: [entry(0, '0000_a', 1000), entry(1, '0000_a', 2000)],
    };
    const v = checkJournalIntegrity(journal, allFilesExist);
    expect(v.map((x) => x.kind)).toContain('duplicate_tag');
  });

  it('8) idx not equal to position (a gap) → idx_not_position', () => {
    const journal: Journal = {
      version: '7',
      dialect: 'postgresql',
      entries: [entry(0, '0000_a', 1000), entry(2, '0002_c', 2000)], // idx 1 skipped
    };
    const v = checkJournalIntegrity(journal, allFilesExist);
    expect(v.map((x) => x.kind)).toContain('idx_not_position');
  });
});

describe('journal-integrity — grandfathered historical inversion', () => {
  it('9) the known 0005/0006 inversion alone is NOT flagged', () => {
    // The real historical pair: 0006 (1779030536556) sits below 0005
    // (1779031200000). Benign per the migrator semantics — must not error.
    const journal: Journal = {
      version: '7',
      dialect: 'postgresql',
      entries: [
        entry(0, '0005_composite_indexes', 1779031200000),
        entry(1, '0006_cool_roulette', 1779030536556),
      ],
    };
    const v = checkJournalIntegrity(journal, allFilesExist);
    expect(v.filter((x) => x.kind === 'when_not_increasing')).toEqual([]);
  });

  it('10) a NON-grandfathered inversion is still flagged (grandfather is exact)', () => {
    const journal: Journal = {
      version: '7',
      dialect: 'postgresql',
      entries: [
        entry(0, '0005_composite_indexes', 1779031200000),
        entry(1, '0099_some_new_migration', 1779030536556), // not grandfathered
      ],
    };
    const v = checkJournalIntegrity(journal, allFilesExist);
    expect(v.map((x) => x.kind)).toContain('when_not_increasing');
    expect(v.find((x) => x.kind === 'when_not_increasing')?.tag).toBe('0099_some_new_migration');
  });
});

describe('journal-integrity — findUnappliedMigrations (runtime reconciliation primitive)', () => {
  const entries = [
    { tag: '0000_a', when: 1000 },
    { tag: '0001_b', when: 2000 },
    { tag: '0002_c', when: 3000 },
  ];

  it('11) all when-values applied → no drift', () => {
    expect(findUnappliedMigrations(entries, [1000, 2000, 3000])).toEqual([]);
  });

  it('12) a missing when (the M-1 skip) → that entry is reported', () => {
    // 0001 was silently skipped: its when is absent from __drizzle_migrations.
    const drift = findUnappliedMigrations(entries, [1000, 3000]);
    expect(drift).toEqual([{ tag: '0001_b', when: 2000 }]);
  });

  it('13) created_at coming back as strings (bigint over the wire) still matches', () => {
    // pg returns bigint columns as strings; the helper must Number()-normalise.
    expect(findUnappliedMigrations(entries, ['1000', '2000', '3000'])).toEqual([]);
  });
});
