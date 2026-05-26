/**
 * Unit tests for the keyset cursor helpers.
 *
 * Coverage:
 *  - encode/decode round-trip
 *  - decode rejects tampered / malformed / wrong-shape input
 *  - decodeCursorOrThrow surfaces D.16 `{ error: { code: 'invalid_cursor' } }`
 *    on every reject path (Audit v1.1 SA-11 — the centralised throw).
 */
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { decodeCursor, decodeCursorOrThrow, encodeCursor } from './keyset-cursor';

describe('keyset-cursor', () => {
  const row = {
    createdAt: new Date('2026-05-25T12:34:56.000Z'),
    id: '00000000-0000-0000-0000-000000000001',
  };

  describe('encode/decode round-trip', () => {
    it('round-trips a valid row', () => {
      const cursor = encodeCursor(row);
      const decoded = decodeCursor(cursor);
      expect(decoded).toEqual({ c: row.createdAt.toISOString(), i: row.id });
    });

    it('encodes to a base64url-safe string (no = / + slashes)', () => {
      const cursor = encodeCursor(row);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('decodeCursor (null on reject)', () => {
    it('returns null on non-base64 garbage', () => {
      expect(decodeCursor('not-base64-!!!')).toBeNull();
    });

    it('returns null on base64 of non-JSON', () => {
      const raw = Buffer.from('not-json').toString('base64url');
      expect(decodeCursor(raw)).toBeNull();
    });

    it('returns null on JSON missing `c`', () => {
      const raw = Buffer.from(JSON.stringify({ i: 'abc' })).toString('base64url');
      expect(decodeCursor(raw)).toBeNull();
    });

    it('returns null on JSON missing `i`', () => {
      const raw = Buffer.from(JSON.stringify({ c: '2026-05-25T00:00:00Z' })).toString('base64url');
      expect(decodeCursor(raw)).toBeNull();
    });

    it('returns null on JSON with non-string c/i', () => {
      const raw = Buffer.from(JSON.stringify({ c: 123, i: 456 })).toString('base64url');
      expect(decodeCursor(raw)).toBeNull();
    });

    it('returns null on unparseable date', () => {
      const raw = Buffer.from(JSON.stringify({ c: 'not-a-date', i: 'abc' })).toString('base64url');
      expect(decodeCursor(raw)).toBeNull();
    });
  });

  describe('decodeCursorOrThrow (SA-11)', () => {
    it('returns the decoded cursor on valid input', () => {
      const cursor = encodeCursor(row);
      const decoded = decodeCursorOrThrow(cursor);
      expect(decoded).toEqual({ c: row.createdAt.toISOString(), i: row.id });
    });

    it('throws BadRequestException with D.16 invalid_cursor envelope on garbage', () => {
      expect.assertions(2);
      try {
        decodeCursorOrThrow('not-base64-!!!');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const body = (err as BadRequestException).getResponse();
        expect(body).toEqual({ error: { code: 'invalid_cursor' } });
      }
    });

    it('throws on wrong-shape JSON (missing fields)', () => {
      const raw = Buffer.from(JSON.stringify({ c: 'only-c' })).toString('base64url');
      expect(() => decodeCursorOrThrow(raw)).toThrow(BadRequestException);
    });

    it('throws on unparseable date', () => {
      const raw = Buffer.from(JSON.stringify({ c: 'not-a-date', i: 'abc' })).toString('base64url');
      expect(() => decodeCursorOrThrow(raw)).toThrow(BadRequestException);
    });
  });
});
