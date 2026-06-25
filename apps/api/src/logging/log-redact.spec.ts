import { describe, expect, it } from 'vitest';

import { LOG_REDACT, LOG_REDACT_PATHS, logRedactCensor, scrubUrlForLog } from './log-redact';

describe('log-redact — pino request-log redaction policy', () => {
  describe('SEC M-2 — referer/referrer are redacted (reset token leak fix)', () => {
    it('redacts req.headers.referer (carries the reset-password ?token=)', () => {
      expect(LOG_REDACT_PATHS).toContain('req.headers.referer');
    });

    it('redacts req.headers.referrer (the misspelled standard header name)', () => {
      expect(LOG_REDACT_PATHS).toContain('req.headers.referrer');
    });

    it('a token-bearing referer value censors to [REDACTED] (no token survives)', () => {
      const fakeToken = 'TESTONLY_' + 'reset_token_placeholder_value';
      const referer = `http://localhost:3001/he/reset-password?token=${fakeToken}`;
      const out = logRedactCensor(referer);
      expect(out).toBe('[REDACTED]');
      expect(String(out)).not.toContain(fakeToken);
    });
  });

  describe('regression — the existing credential + PII redactions stay', () => {
    it.each([
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.token',
      'req.body.national_id',
      'req.body.phone',
      'req.params.token',
      'req.body.signatureSvg',
    ])('still redacts %s', (path) => {
      expect(LOG_REDACT_PATHS).toContain(path);
    });

    it('LOG_REDACT wires the paths + the censor for pino', () => {
      expect(LOG_REDACT.paths).toEqual([...LOG_REDACT_PATHS]);
      expect(LOG_REDACT.censor).toBe(logRedactCensor);
    });
  });

  describe('censor — /sign/<jwt> URLs keep their shape, only the token is masked', () => {
    it('surgically masks the /sign/<jwt> segment, preserving the rest', () => {
      const url = 'GET /sign/aaa.bbb.ccc completed';
      expect(logRedactCensor(url)).toBe('GET /sign/[REDACTED] completed');
    });

    it('is stable across repeated calls (global-regex lastIndex reset)', () => {
      const url = '/sign/aaa.bbb.ccc';
      expect(logRedactCensor(url)).toBe('/sign/[REDACTED]');
      // Second call must produce the SAME result — guards the lastIndex reset.
      expect(logRedactCensor(url)).toBe('/sign/[REDACTED]');
    });

    it('fully redacts a non-URL credential value', () => {
      expect(logRedactCensor('Bearer abc.def.ghi')).toBe('[REDACTED]');
    });
  });

  describe('SEC-TOKEN-LOG (HIGH) — the signing JWT in req.url must be masked, route kept', () => {
    it('redacts req.url (the leak: full /sign/<jwt> landed in req.url verbatim)', () => {
      expect(LOG_REDACT_PATHS).toContain('req.url');
    });

    it('redacts req.query.token (belt-and-suspenders for a query-object token)', () => {
      expect(LOG_REDACT_PATHS).toContain('req.query.token');
    });

    it('REGRESSION — masks the token on req.url while keeping the route legible', () => {
      // The exact leak: the public-sign route is called as /api/v1/sign/<jwt>;
      // pino serialized the FULL path into req.url. The path-aware censor must
      // mask the token segment but leave the route visible.
      // Placeholder that matches the JWT-shape regex (header.payload.signature)
      // WITHOUT being a real-looking base64url JWT (avoids tripping secret scanners).
      const jwt = 'HEADERseg.PAYLOADseg.SIGNATUREseg';
      const out = logRedactCensor(`/api/v1/sign/${jwt}`, ['req', 'url']);
      expect(out).toBe('/api/v1/sign/[REDACTED]');
      expect(String(out)).not.toContain(jwt);
    });

    it('OBSERVABILITY GUARD — a benign URL on req.url is PRESERVED, not [REDACTED]', () => {
      // The naive "add req.url to paths" fix would blanket-redact every URL to
      // [REDACTED], blinding ops to which endpoint was hit. The route + benign
      // query (limit/cursor/status) must survive.
      const url = '/api/v1/projects?limit=25&status=gathering_signatures';
      expect(logRedactCensor(url, ['req', 'url'])).toBe(url);
    });

    it('scrubs a sensitive query value on req.url, keeps the key + route + benign params', () => {
      const out = logRedactCensor('/api/v1/auth/x?token=SUPERSECRET&foo=bar', ['req', 'url']);
      expect(out).toBe('/api/v1/auth/x?token=[REDACTED]&foo=bar');
      expect(String(out)).not.toContain('SUPERSECRET');
    });

    it('a credential leaf (authorization) is STILL fully redacted even with a path', () => {
      expect(logRedactCensor('Bearer abc.def.ghi', ['req', 'headers', 'authorization'])).toBe(
        '[REDACTED]',
      );
    });

    it('scrubUrlForLog masks /sign/<jwt> and sensitive query values, preserves the rest', () => {
      expect(scrubUrlForLog('/api/v1/sign/aaa.bbb.ccc')).toBe('/api/v1/sign/[REDACTED]');
      expect(scrubUrlForLog('/api/v1/projects?limit=25')).toBe('/api/v1/projects?limit=25');
      expect(scrubUrlForLog('/x?otp=123456&page=2')).toBe('/x?otp=[REDACTED]&page=2');
    });

    it('is stable across repeated req.url calls (shared global-regex lastIndex reset)', () => {
      const url = '/api/v1/sign/aaa.bbb.ccc';
      expect(logRedactCensor(url, ['req', 'url'])).toBe('/api/v1/sign/[REDACTED]');
      expect(logRedactCensor(url, ['req', 'url'])).toBe('/api/v1/sign/[REDACTED]');
    });
  });
});
