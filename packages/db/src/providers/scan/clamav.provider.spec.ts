/**
 * Unit tests for the ClamAV file-scan provider (P0.B1). Pure unit: a fake
 * socket is injected via `connectImpl`, so there is NO network and NO DB. The
 * security-critical contract is FAIL-CLOSED — any non-`OK` clamd reply or
 * transport failure must resolve to a non-`clean` verdict (never throw, never
 * a false clean).
 */
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { ClamAvFileScanProvider, buildInstream, parseReply } from './clamav.provider';

/** A minimal fake clamd socket: on write it "replies" with `reply` then ends.
 *  `mode='error'` emits a socket error; `mode='timeout'` emits a timeout. */
function fakeSocket(reply: string, mode: 'ok' | 'error' | 'timeout' = 'ok'): Socket {
  const sock = new EventEmitter() as unknown as Socket & EventEmitter;
  (sock as unknown as { setTimeout: () => void }).setTimeout = () => undefined;
  (sock as unknown as { write: (b: Buffer) => void }).write = () => {
    queueMicrotask(() => {
      if (mode === 'error') return sock.emit('error', new Error('ECONNREFUSED'));
      if (mode === 'timeout') return sock.emit('timeout');
      sock.emit('data', Buffer.from(reply, 'utf8'));
      sock.emit('end');
    });
  };
  (sock as unknown as { destroy: () => void }).destroy = () => undefined;
  (sock as unknown as { removeAllListeners: () => void }).removeAllListeners = () => undefined;
  // The provider attaches listeners then 'connect' fires the write.
  queueMicrotask(() => sock.emit('connect'));
  return sock as unknown as Socket;
}

function makeProvider(reply: string, mode: 'ok' | 'error' | 'timeout' = 'ok') {
  return new ClamAvFileScanProvider({
    host: 'clamd.test',
    port: 3310,
    connectImpl: () => fakeSocket(reply, mode),
  });
}

const input = { key: 'org/x/doc/y', bytes: Buffer.from('hello') };

describe('parseReply (pure)', () => {
  it('stream: OK → clean', () => {
    expect(parseReply('stream: OK')).toEqual({ verdict: 'clean' });
  });
  it('stream: <sig> FOUND → infected + signature label', () => {
    expect(parseReply('stream: Eicar-Test-Signature FOUND')).toEqual({
      verdict: 'infected',
      signature: 'Eicar-Test-Signature',
    });
  });
  it('unrecognised / ERROR reply → error (fail-closed)', () => {
    expect(parseReply('INSTREAM size limit exceeded ERROR').verdict).toBe('error');
    expect(parseReply('garbage').verdict).toBe('error');
  });
  it('never returns clean for a non-OK reply', () => {
    for (const r of ['', 'FOUND', 'stream: Win.Test FOUND', 'ERROR', 'PONG']) {
      const v = parseReply(r).verdict;
      if (r.endsWith('OK')) expect(v).toBe('clean');
      else expect(v).not.toBe('clean');
    }
  });
});

describe('buildInstream (framing)', () => {
  it('starts with zINSTREAM\\0 and ends with a zero-length terminator', () => {
    const framed = buildInstream(Buffer.from('abc'));
    expect(framed.subarray(0, 10).toString('ascii')).toBe('zINSTREAM\0');
    // last 4 bytes = uint32 BE 0 (terminator)
    expect(framed.readUInt32BE(framed.length - 4)).toBe(0);
  });
});

describe('scan (fail-closed)', () => {
  it('clean reply → clean', async () => {
    expect(await makeProvider('stream: OK').scan(input)).toEqual({ verdict: 'clean' });
  });
  it('infected reply → infected', async () => {
    const r = await makeProvider('stream: Eicar-Test-Signature FOUND').scan(input);
    expect(r.verdict).toBe('infected');
  });
  it('socket error → error verdict (never throws)', async () => {
    const r = await makeProvider('', 'error').scan(input);
    expect(r.verdict).toBe('error');
  });
  it('timeout → error verdict (never throws)', async () => {
    const r = await makeProvider('', 'timeout').scan(input);
    expect(r.verdict).toBe('error');
  });
  it('no bytes supplied → error (this provider needs content)', async () => {
    const r = await makeProvider('stream: OK').scan({ key: 'k' });
    expect(r.verdict).toBe('error');
  });
  it('lazy byte loader is resolved', async () => {
    const loader = vi.fn(async () => Buffer.from('lazy'));
    const r = await makeProvider('stream: OK').scan({ key: 'k', bytes: loader });
    expect(loader).toHaveBeenCalledOnce();
    expect(r.verdict).toBe('clean');
  });
});
