import type { Event } from '@sentry/node';
import { describe, expect, it } from 'vitest';

import { scrubEventCredentials } from './instrument';

// Placeholder JWT shape `x.y.z` — NEVER a realistic `eyJ…` literal (GitGuardian
// would flag a real-looking token even in a test fixture).
const FAKE_JWT = 'HEADERseg.PAYLOADseg.SIGseg';
const SIGN_URL = `https://api.emapp.co.il/api/v1/sign/${FAKE_JWT}`;

describe('scrubEventCredentials — SEC-TOKEN-SENTRY #9', () => {
  it('masks the /sign/<jwt> path segment in event.request.url', () => {
    const event: Event = { request: { url: SIGN_URL } };
    const out = scrubEventCredentials(event);
    expect(out.request?.url).toBe('https://api.emapp.co.il/api/v1/sign/[REDACTED]');
    expect(out.request?.url).not.toContain(FAKE_JWT);
  });

  it('masks a ?token= query value in event.request.url (route kept)', () => {
    const event: Event = {
      request: { url: `https://api.emapp.co.il/api/v1/accept?token=${FAKE_JWT}&page=2` },
    };
    const out = scrubEventCredentials(event);
    expect(out.request?.url).toBe('https://api.emapp.co.il/api/v1/accept?token=[REDACTED]&page=2');
    expect(out.request?.url).not.toContain(FAKE_JWT);
  });

  it('masks a sensitive value in a string query_string', () => {
    const event: Event = { request: { query_string: `token=${FAKE_JWT}&limit=20` } };
    const out = scrubEventCredentials(event);
    expect(out.request?.query_string).toBe('token=[REDACTED]&limit=20');
    expect(JSON.stringify(out.request?.query_string)).not.toContain(FAKE_JWT);
  });

  it('masks a sensitive value in an object query_string, keeps benign keys', () => {
    const event: Event = {
      request: { query_string: { token: FAKE_JWT, status: 'active' } },
    };
    const out = scrubEventCredentials(event);
    expect(out.request?.query_string).toEqual({ token: '[REDACTED]', status: 'active' });
    expect(JSON.stringify(out.request?.query_string)).not.toContain(FAKE_JWT);
  });

  it('masks a sensitive value in an array query_string', () => {
    const event: Event = {
      request: {
        query_string: [
          ['token', FAKE_JWT],
          ['cursor', 'abc'],
        ],
      },
    };
    const out = scrubEventCredentials(event);
    expect(out.request?.query_string).toEqual([
      ['token', '[REDACTED]'],
      ['cursor', 'abc'],
    ]);
    expect(JSON.stringify(out.request?.query_string)).not.toContain(FAKE_JWT);
  });

  it('masks /sign/<jwt> URLs in breadcrumb message + data.url', () => {
    const event: Event = {
      breadcrumbs: [
        {
          category: 'http',
          message: `GET ${SIGN_URL} 500`,
          data: { url: SIGN_URL },
        },
      ],
    };
    const out = scrubEventCredentials(event);
    const crumb = out.breadcrumbs?.[0];
    expect(crumb?.message).toBe('GET https://api.emapp.co.il/api/v1/sign/[REDACTED] 500');
    expect(crumb?.data?.['url']).toBe('https://api.emapp.co.il/api/v1/sign/[REDACTED]');
    expect(JSON.stringify(out)).not.toContain(FAKE_JWT);
  });

  it('redacts credential-bearing request headers (referer/cookie/authorization)', () => {
    const event: Event = {
      request: {
        headers: {
          Referer: SIGN_URL,
          Cookie: 'emapp_session=secret-value',
          authorization: 'Bearer some-bearer',
          'user-agent': 'Mozilla/5.0',
        },
      },
    };
    const out = scrubEventCredentials(event);
    expect(out.request?.headers?.['Referer']).toBe('[REDACTED]');
    expect(out.request?.headers?.['Cookie']).toBe('[REDACTED]');
    expect(out.request?.headers?.['authorization']).toBe('[REDACTED]');
    // Benign header kept for observability.
    expect(out.request?.headers?.['user-agent']).toBe('Mozilla/5.0');
    expect(JSON.stringify(out)).not.toContain(FAKE_JWT);
  });

  it('redacts the SDK-parsed cookie dict (event.request.cookies — bearer creds)', () => {
    const event: Event = {
      request: {
        cookies: { access_token: FAKE_JWT, refresh_token: 'refresh-secret', locale: 'he' },
      },
    };
    const out = scrubEventCredentials(event);
    expect(out.request?.cookies?.['access_token']).toBe('[REDACTED]');
    expect(out.request?.cookies?.['refresh_token']).toBe('[REDACTED]');
    // Even the benign cookie value is dropped — a parsed cookie value is never
    // useful observability and we keep zero credential risk.
    expect(out.request?.cookies?.['locale']).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain(FAKE_JWT);
  });

  it('redacts sensitive leaf keys in the captured request body (event.request.data)', () => {
    // POST /api/v1/auth/accept-invite ships { token, password } as the body.
    const event: Event = {
      request: {
        url: 'https://api.emapp.co.il/api/v1/auth/accept-invite',
        data: { token: FAKE_JWT, password: 'hunter2', name: 'Dana' },
      },
    };
    const out = scrubEventCredentials(event);
    const body = out.request?.data as Record<string, unknown>;
    expect(body['token']).toBe('[REDACTED]');
    expect(body['password']).toBe('[REDACTED]');
    // Non-sensitive field kept for debugging.
    expect(body['name']).toBe('Dana');
    expect(JSON.stringify(out)).not.toContain(FAKE_JWT);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('redacts owner PII (national_id/phone) in a captured request body', () => {
    const event: Event = {
      request: { data: { national_id: '123456782', phone: '+972501234567', city: 'תל אביב' } },
    };
    const out = scrubEventCredentials(event);
    const body = out.request?.data as Record<string, unknown>;
    expect(body['national_id']).toBe('[REDACTED]');
    expect(body['phone']).toBe('[REDACTED]');
    expect(body['city']).toBe('תל אביב');
  });

  it('opaque-redacts a raw STRING request body (credential could be anywhere)', () => {
    const event: Event = { request: { data: `token=${FAKE_JWT}&password=hunter2` } };
    const out = scrubEventCredentials(event);
    expect(out.request?.data).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain(FAKE_JWT);
  });

  it('masks a /sign/<jwt> URL in event.exception.values[].value (the #1 egress)', () => {
    const event: Event = {
      exception: {
        values: [{ type: 'Error', value: `request to ${SIGN_URL} failed with 500` }],
      },
    };
    const out = scrubEventCredentials(event);
    expect(out.exception?.values?.[0]?.value).toBe(
      'request to https://api.emapp.co.il/api/v1/sign/[REDACTED] failed with 500',
    );
    expect(JSON.stringify(out)).not.toContain(FAKE_JWT);
  });

  it('masks event.message and event.transaction', () => {
    const event: Event = { message: `boom at ${SIGN_URL}`, transaction: `GET ${SIGN_URL}` };
    const out = scrubEventCredentials(event);
    expect(out.message).toBe('boom at https://api.emapp.co.il/api/v1/sign/[REDACTED]');
    expect(out.transaction).toBe('GET https://api.emapp.co.il/api/v1/sign/[REDACTED]');
    expect(JSON.stringify(out)).not.toContain(FAKE_JWT);
  });

  it('masks URL keys in transaction span data', () => {
    const event: Event = {
      spans: [
        {
          span_id: 's1',
          trace_id: 't1',
          start_timestamp: 0,
          data: { 'http.url': SIGN_URL, 'http.method': 'GET' },
        },
      ],
    };
    const out = scrubEventCredentials(event);
    expect(out.spans?.[0]?.data?.['http.url']).toBe(
      'https://api.emapp.co.il/api/v1/sign/[REDACTED]',
    );
    expect(out.spans?.[0]?.data?.['http.method']).toBe('GET');
    expect(JSON.stringify(out)).not.toContain(FAKE_JWT);
  });

  it('is fail-OPEN: a malformed event (null breadcrumb) never throws', () => {
    const event = {
      breadcrumbs: [null, { message: `GET ${SIGN_URL}` }],
    } as unknown as Event;
    // Must not throw — a throw in beforeSend would drop the event.
    const out = scrubEventCredentials(event);
    expect(out).toBe(event);
  });

  it('passes through an event with no credential-bearing fields untouched', () => {
    const event: Event = {
      request: { url: 'https://api.emapp.co.il/api/v1/projects?limit=20', method: 'GET' },
      message: 'boom',
    };
    const out = scrubEventCredentials(event);
    expect(out.request?.url).toBe('https://api.emapp.co.il/api/v1/projects?limit=20');
    expect(out.message).toBe('boom');
  });
});
