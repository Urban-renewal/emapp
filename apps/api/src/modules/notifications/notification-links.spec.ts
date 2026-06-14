import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { notificationLink } from './notification-links';

const ID = '00000000-0000-4000-8000-000000000abc';

describe('notificationLink — deep-link builder', () => {
  it('builds the entity-detail path for each notification target', () => {
    expect(notificationLink.document(ID)).toBe(`/documents/${ID}`);
    expect(notificationLink.apartment(ID)).toBe(`/apartments/${ID}`);
    expect(notificationLink.note(ID)).toBe(`/notes/${ID}`);
    expect(notificationLink.task(ID)).toBe(`/tasks/${ID}`);
    expect(notificationLink.projectShares(ID)).toBe(`/projects/${ID}/shares`);
  });

  it('every path is root-absolute and locale-prefix-free (the FE <Link> adds /he|/en)', () => {
    const paths = [
      notificationLink.document(ID),
      notificationLink.apartment(ID),
      notificationLink.note(ID),
      notificationLink.task(ID),
      notificationLink.projectShares(ID),
    ];
    for (const p of paths) {
      expect(p.startsWith('/'), `${p} must be root-absolute`).toBe(true);
      expect(p, `${p} must not carry a locale prefix`).not.toMatch(/^\/(he|en)\//);
    }
  });
});

/**
 * RATCHET — a notification must be CLICKABLE: every in-app notification the
 * producer emits has to carry a real deep-link, never `link: null`. The FE
 * renders the link as the row's primary affordance; a null link is a dead
 * notification (the exact "התראות לא עובדות" complaint). This guard scans the
 * business modules and fails if any `link: null` reappears — forcing a new
 * emit site to pick (or add) a `notificationLink.*` target.
 */
describe('architecture: notifications carry a deep-link (no link: null)', () => {
  const MODULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.name.endsWith('.service.ts')) {
        const src = readFileSync(p, 'utf8');
        if (/\blink:\s*null\b/.test(src)) offenders.push(p);
      }
    }
  };
  walk(MODULES_DIR);

  it('no business service emits a notification with link: null', () => {
    expect(
      offenders,
      `These services contain \`link: null\` — a notification must deep-link to its ` +
        `entity (use notificationLink.* with the id already in metadata):\n` +
        offenders.map((f) => `  - ${f}`).join('\n'),
    ).toEqual([]);
  });
});
