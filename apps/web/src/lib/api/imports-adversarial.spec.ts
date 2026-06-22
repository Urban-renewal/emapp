/**
 * AUDIT — adversarial tests for the imports API client (D.34) presigned PUT.
 *
 * task_40412210 (defense-in-depth, mirrors documents #500): the xlsx-import
 * presigned PUT is now create-only + checksum-bound. The BE signs
 * `If-None-Match: *` + `x-amz-checksum-sha256` INTO the URL; the control is
 * only CLOSED when the client ALSO sends those exact header values on the PUT.
 * These tests pin the client side:
 *   - uploadToPresignedXhr SENDS both headers when the guards are passed.
 *   - it OMITS them on the legacy path (backward compat).
 *   - hexSha256ToBase64 produces the IDENTICAL base64 the BE binds, so the
 *     sent checksum == the signed checksum (R2 BadDigest otherwise).
 *
 * The upload uses XMLHttpRequest (for upload-progress events), so we stub a
 * minimal XHR that records setRequestHeader calls and fires onload(200).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hexSha256ToBase64, uploadToPresignedXhr } from './imports';

interface CapturedXhr {
  method?: string;
  url?: string;
  headers: Record<string, string>;
}

const captured: CapturedXhr[] = [];
const originalXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;

/** Minimal XHR double — enough for uploadToPresignedXhr: open + a few
 *  setRequestHeader calls + an upload.onprogress hook + send → onload(200). */
class FakeXhr {
  public status = 0;
  public upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onabort: (() => void) | null = null;
  private rec: CapturedXhr = { headers: {} };

  open(method: string, url: string): void {
    this.rec.method = method;
    this.rec.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.rec.headers[name] = value;
  }
  send(): void {
    captured.push(this.rec);
    this.status = 200;
    // Fire async-ish but synchronously enough for the awaited Promise.
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  captured.length = 0;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest =
    FakeXhr as unknown as typeof XMLHttpRequest;
});
afterEach(() => {
  if (originalXhr === undefined) delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  else (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = originalXhr;
});

describe('imports presigned PUT — B7 anti-overwrite (task_40412210)', () => {
  it('B7-IMP1) uploadToPresignedXhr SENDS If-None-Match + x-amz-checksum-sha256 when guards are passed', async () => {
    const checksumB64 = hexSha256ToBase64('a'.repeat(64));
    await uploadToPresignedXhr(
      'https://r2/import/x',
      new Blob(['x']),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      undefined,
      { createOnly: true, contentSha256Base64: checksumB64 },
    );
    const headers = captured[0]?.headers ?? {};
    expect(headers['If-None-Match'], 'create-only header must be sent to R2').toBe('*');
    expect(headers['x-amz-checksum-sha256'], 'checksum header must be sent to R2').toBe(
      checksumB64,
    );
    // Content-Type is still the bound xlsx mime.
    expect(headers['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('B7-IMP2) uploadToPresignedXhr omits the guard headers when none are requested (legacy path unchanged)', async () => {
    await uploadToPresignedXhr('https://r2/import/x', new Blob(['x']), 'application/octet-stream');
    const headers = captured[0]?.headers ?? {};
    expect(headers['If-None-Match']).toBeUndefined();
    expect(headers['x-amz-checksum-sha256']).toBeUndefined();
  });

  it('B7-IMP3) hexSha256ToBase64 converts a hex digest to base64-of-raw the way the BE binds it', () => {
    // The BE does Buffer.from(hex,'hex').toString('base64'); the FE must produce
    // the IDENTICAL string so the sent checksum == the signed checksum.
    const hex = 'a'.repeat(64);
    expect(hexSha256ToBase64(hex)).toBe(Buffer.from(hex, 'hex').toString('base64'));
    const real = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
    expect(hexSha256ToBase64(real)).toBe(Buffer.from(real, 'hex').toString('base64'));
    // Non-canonical input degrades to '' (safe — mirrors the BE's degrade).
    expect(hexSha256ToBase64('not-hex')).toBe('');
    expect(hexSha256ToBase64('abc')).toBe('');
  });
});
