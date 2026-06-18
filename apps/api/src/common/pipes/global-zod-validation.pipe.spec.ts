import { BadRequestException, type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { GlobalZodValidationPipe } from './global-zod-validation.pipe';
import { hasUnstorableText } from './unstorable-text';

/**
 * S0-SEC — the global APP_PIPE backstop. Asserts: (1) it never mutates a
 * passed value (existing endpoint behaviour is byte-identical); (2) it rejects
 * NUL / lone-surrogate text on body/query/param with the D.16 envelope;
 * (3) it leaves `custom`-decorator args (@CurrentUser/@Req/@Res) untouched;
 * (4) raw binary bodies (the documents `:id/content` Buffer) are short-circuited
 * — no O(n) per-byte scan, no DoS, returned unchanged.
 */
const meta = (type: ArgumentMetadata['type']): ArgumentMetadata => ({
  type,
  metatype: undefined,
  data: undefined,
});

describe('GlobalZodValidationPipe', () => {
  const pipe = new GlobalZodValidationPipe();

  it('passes a clean body through UNCHANGED (referential identity)', () => {
    const value = { name: 'אבי', nested: { a: [1, 2, 'ok'] } };
    expect(pipe.transform(value, meta('body'))).toBe(value);
  });

  it('rejects a NUL in a body string with the D.16 validation_error envelope', () => {
    const value = { name: `a${String.fromCharCode(0)}b` };
    try {
      pipe.transform(value, meta('body'));
      throw new Error('expected a BadRequestException');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toEqual({
        error: { code: 'validation_error', details: { _: ['contains NUL or invalid UTF-8'] } },
      });
    }
  });

  it('rejects a lone surrogate in a query value', () => {
    const value = { q: String.fromCharCode(0xd800) }; // unpaired high surrogate
    expect(() => pipe.transform(value, meta('query'))).toThrow(BadRequestException);
  });

  it('does NOT scan custom-decorator args (e.g. @CurrentUser / @Req)', () => {
    // A request object could contain anything; the pipe must not inspect it.
    const reqLike = { headers: { x: `bad${String.fromCharCode(0)}` } };
    expect(pipe.transform(reqLike, meta('custom'))).toBe(reqLike);
  });

  it('short-circuits a raw Buffer body (no per-byte scan) and returns it unchanged', () => {
    // A 50MB-class buffer that, byte-wise, contains a 0x00 — under the OLD
    // recursive object scan this both DoS-ed and (correctly) found nothing.
    // It must now pass straight through.
    const buf = Buffer.alloc(1024, 0); // all-NUL bytes
    expect(pipe.transform(buf, meta('body'))).toBe(buf);
    expect(hasUnstorableText(buf)).toBe(false);
    expect(hasUnstorableText(new Uint8Array([0, 1, 2]))).toBe(false);
  });
});
