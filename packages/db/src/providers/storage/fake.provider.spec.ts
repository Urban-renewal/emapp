/**
 * Adversarial unit tests for `FakeStorageProvider`'s dev-fallback safety
 * flag (`failUrlsOutsideTest`). Authored by a separate TEST-AUTHOR — these
 * tests do NOT trust the builder.
 *
 * Two load-bearing invariants:
 *
 *   1. FAIL-LOUD (dev fallback): with `failUrlsOutsideTest: true`,
 *      `getUploadUrl`/`getDownloadUrl` THROW the actionable
 *      `STORAGE_NOT_CONFIGURED_MESSAGE` instead of minting a
 *      `https://fake-storage.test/…` URL that 404s downstream. The
 *      in-memory `setObject`/`getObjectStream` path is UNAFFECTED — it
 *      still works, because that flag only gates the two URL-minting
 *      methods. Mutation-check: if the `throw` is removed from
 *      `getUploadUrl`/`getDownloadUrl`, the two "rejects" assertions
 *      below fail.
 *
 *   2. TEST-MODE UNCHANGED: the default `new FakeStorageProvider()` (flag
 *      `false`) returns the exact `https://fake-storage.test/…` URLs as
 *      before — proving the byte-for-byte test/worker behaviour is intact.
 *
 * Pure: no DB, no network, no env mutation.
 */
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { FakeStorageProvider, STORAGE_NOT_CONFIGURED_MESSAGE } from './fake.provider';

const KEY = 'org/abc/doc/123';
const UPLOAD_OPTS = {
  contentType: 'application/pdf',
  maxSizeBytes: 10_000_000,
  ttlSeconds: 300,
} as const;
const DOWNLOAD_OPTS = { ttlSeconds: 120 } as const;

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

describe('FakeStorageProvider · failUrlsOutsideTest (dev fallback fail-loud)', () => {
  describe('flag TRUE — dev fallback (R2 unconfigured, not test)', () => {
    it('getUploadUrl REJECTS with the actionable not-configured message', async () => {
      const p = new FakeStorageProvider({ failUrlsOutsideTest: true });
      await expect(p.getUploadUrl(KEY, UPLOAD_OPTS)).rejects.toThrow(
        STORAGE_NOT_CONFIGURED_MESSAGE,
      );
    });

    it('getDownloadUrl REJECTS with the actionable not-configured message', async () => {
      const p = new FakeStorageProvider({ failUrlsOutsideTest: true });
      await expect(p.getDownloadUrl(KEY, DOWNLOAD_OPTS)).rejects.toThrow(
        STORAGE_NOT_CONFIGURED_MESSAGE,
      );
    });

    it('throwing branch records nothing (no fake URL minted/tracked)', async () => {
      // A resolved fake URL would silently 404 downstream (the exact bug);
      // the throwing path must not record an upload/download either.
      const p = new FakeStorageProvider({ failUrlsOutsideTest: true });
      await p.getUploadUrl(KEY, UPLOAD_OPTS).catch(() => undefined);
      await p.getDownloadUrl(KEY, DOWNLOAD_OPTS).catch(() => undefined);
      expect(p.uploaded).toHaveLength(0);
      expect(p.downloaded).toHaveLength(0);
    });

    it('in-memory setObject + getObjectStream STILL WORK (flag gates URLs only)', async () => {
      const p = new FakeStorageProvider({ failUrlsOutsideTest: true });
      p.setObject(KEY, Buffer.from('hello-bytes', 'utf8'));
      const stream = await p.getObjectStream(KEY);
      expect(await streamToString(stream)).toBe('hello-bytes');
      // head/delete unaffected too.
      expect(await p.head(KEY)).toBeNull();
      await p.delete(KEY);
      expect(p.deleted).toEqual([KEY]);
    });
  });

  describe('flag FALSE / default — test mode UNCHANGED (byte-for-byte URLs)', () => {
    it('default ctor: getUploadUrl returns the exact fake-storage.test upload URL', async () => {
      const p = new FakeStorageProvider();
      const url = await p.getUploadUrl(KEY, UPLOAD_OPTS);
      expect(url).toBe(
        `https://fake-storage.test/upload/${KEY}?contentType=${UPLOAD_OPTS.contentType}`,
      );
      expect(p.uploaded).toEqual([{ key: KEY, opts: UPLOAD_OPTS }]);
    });

    it('default ctor: getDownloadUrl returns the exact fake-storage.test download URL', async () => {
      const p = new FakeStorageProvider();
      const url = await p.getDownloadUrl(KEY, DOWNLOAD_OPTS);
      expect(url).toBe(`https://fake-storage.test/download/${KEY}`);
      expect(p.downloaded).toEqual([{ key: KEY, opts: DOWNLOAD_OPTS }]);
    });

    it('explicit { failUrlsOutsideTest: false } behaves identically to default', async () => {
      const p = new FakeStorageProvider({ failUrlsOutsideTest: false });
      await expect(p.getUploadUrl(KEY, UPLOAD_OPTS)).resolves.toBe(
        `https://fake-storage.test/upload/${KEY}?contentType=${UPLOAD_OPTS.contentType}`,
      );
      await expect(p.getDownloadUrl(KEY, DOWNLOAD_OPTS)).resolves.toBe(
        `https://fake-storage.test/download/${KEY}`,
      );
    });

    it('in-memory setObject + getObjectStream work (default)', async () => {
      const p = new FakeStorageProvider();
      p.setObject(KEY, Buffer.from('payload', 'utf8'));
      expect(await streamToString(await p.getObjectStream(KEY))).toBe('payload');
    });
  });
});
