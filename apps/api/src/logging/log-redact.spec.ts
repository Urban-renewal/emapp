import { describe, expect, it } from 'vitest';

import { LOG_REDACT, LOG_REDACT_PATHS, logRedactCensor } from './log-redact';

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
});
