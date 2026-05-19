/**
 * Phase 4 unit proof — storage helpers (deterministic, zero-infra).
 * Pins: factory FAILS FAST in production (no silent Fake); the object key
 * is server-generated, org-partitioned and unguessable; the download
 * filename is sanitised (no header-injection / path / quotes).
 */
import { FakeStorageProvider } from '@emapp/db';
import { afterEach, describe, expect, it } from 'vitest';

import { newDocumentKey, safeDownloadFilename, storageProviderFactory } from './storage';

describe('Phase 4 · storage helpers', () => {
  const prev = process.env['NODE_ENV'];
  afterEach(() => {
    if (prev === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = prev;
  });

  it('factory returns Fake outside prod; FAILS FAST in production', async () => {
    const p = storageProviderFactory();
    expect(p).toBeInstanceOf(FakeStorageProvider);
    process.env['NODE_ENV'] = 'production';
    expect(() => storageProviderFactory()).toThrowError(/refusing to boot/i);
  });

  it('newDocumentKey: org-partitioned, unguessable, unique', () => {
    const org = '11111111-1111-1111-1111-111111111111';
    const k1 = newDocumentKey(org);
    const k2 = newDocumentKey(org);
    expect(k1).toMatch(/^org\/11111111-1111-1111-1111-111111111111\/doc\/[0-9a-f-]{36}$/);
    expect(k1).not.toBe(k2); // random uuid → not predictable/sequential
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
