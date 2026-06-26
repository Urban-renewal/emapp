// PERF (2026-06-21): prefer IPv4 for upstream/localhost resolution. Node 18+
// defaults DNS result order to "verbatim" → it tries IPv6 `[::1]` FIRST for
// `localhost`, which on hosts without an IPv6 loopback fast-path (notably the
// Windows dev box) is slow / times out (~0.2s–2s per connection). That penalty
// hit every server-side fetch — in dev it compounded across the getMe →
// same-origin-proxy → API hops into a ~1.6s authenticated home render (every
// click > 1s). `ipv4first` restores the pre-Node-18 default; all our upstreams
// (Neon, R2, Resend, local PG) are reachable over IPv4, so it is safe in prod.
import dns from 'node:dns';

import { setPoolErrorObserver } from '@emapp/db';
import * as Sentry from '@sentry/node';
import type { Event } from '@sentry/node';

import { scrubUrlForLog } from './logging/log-redact';

dns.setDefaultResultOrder('ipv4first');

// SEC-TOKEN-SENTRY (red-team 2026-06-25, HIGH — defect #9): an error on the
// no-auth signing route `/api/v1/sign/<jwt>` (or any `?token=…` / token-path
// URL) ships the owner's FULL bearer credential to Sentry. The SDK's default
// pipeline populates the token into MANY fields and scrubs NONE of them; we
// must cover every egress the canonical pino request-logger sink already covers
// (`LOG_REDACT_PATHS` in log-redact.ts), or the Sentry sink leaks exactly what
// the log sink protects. Fields scrubbed here, all via the CANONICAL
// `scrubUrlForLog` seam (single source of truth — NOT a second regex, so the
// two sinks can never drift):
//   - `event.request.url` + `query_string` (string/object/array shapes)
//   - `event.request.headers` referer/referrer/cookie/authorization → dropped
//     (a browser on `/sign/<jwt>` sends the token in `Referer`; cookie/auth are
//     bearer secrets) — identical to the pino redactor
//   - `event.request.cookies` (the SDK-PARSED cookie dict, a separate field
//     from the header — holds access_token/refresh_token) → every value dropped
//   - `event.request.data` (the CAPTURED REQUEST BODY — invite/reset token,
//     password, owner national_id/phone) → sensitive leaf keys redacted (object)
//     / opaque-redacted (raw string), mirroring the pino body-redaction policy
//   - `event.message` + `event.transaction` (route name)
//   - `event.exception.values[].value` (the #1 egress: a throw on `/sign/:token`
//     interpolates the URL into the error message)
//   - `event.breadcrumbs[].message` + `.data.url` (http breadcrumbs)
//   - `event.spans[].data.{url,http.url,http.target}` (OTel http spans)
// Applied in `beforeSend` (errors) + `beforeSendTransaction` (traces). Total +
// fail-OPEN: a malformed event is returned un-thrown (a throw in beforeSend
// makes the SDK DROP the event), but every credential-bearing string IS
// scrubbed. (Closed under independent red-team loop — headers/exception/
// message/transaction/spans gaps found + fixed before merge.)
// Header names whose VALUE can carry a credential-bearing URL or a bearer
// secret — fully redacted, IDENTICAL to the pino request-logger sink
// (`LOG_REDACT_PATHS` in log-redact.ts: authorization/cookie/referer/referrer).
// A browser on the no-auth `/sign/<jwt>` or `/accept-invite/<token>` page sends
// the token in `Referer`; the session/refresh cookie is in `Cookie`; a bearer
// is in `Authorization`. All three would otherwise ship to Sentry verbatim via
// `requestDataIntegration` (include.headers defaults true).
const REDACTED_HEADER = new Set(['authorization', 'cookie', 'referer', 'referrer']);

// Span-data keys that hold a URL (OTel http spans) — scrubbed via the canonical
// URL seam so a `/sign/<jwt>` outbound/inbound URL can't ride a transaction.
const URL_SPAN_DATA_KEY = new Set(['url', 'http.url', 'http.target']);

// Request-body leaf keys that are credentials/PII — redacted to match the pino
// sink (`LOG_REDACT_PATHS`: req.body.password/token/national_id/phone/
// signatureSvg). Sentry's default httpIntegration buffers the raw request body
// into `event.request.data`, so `POST /auth/accept-invite { token, password }`,
// login/reset bodies, and owner create/update PII would otherwise egress.
// Keys are lowercased; matched case-insensitively against the body's keys.
const SENSITIVE_BODY_KEY = new Set(['password', 'token', 'national_id', 'phone', 'signaturesvg']);

export function scrubEventCredentials<T extends Event>(event: T): T {
  // Total + fail-OPEN on shape: a malformed event must never throw inside the
  // Sentry pipeline (a throw in beforeSend makes the SDK DROP the original
  // event and re-capture our error — telemetry loss). On any unexpected shape
  // we return the event as-is rather than crash.
  try {
    // ---- event.request --------------------------------------------------
    const req = event.request;
    if (req) {
      if (typeof req.url === 'string') {
        req.url = scrubUrlForLog(req.url);
      }
      req.query_string = scrubQueryString(req.query_string);
      // Headers: drop the credential-bearing ones to match the log sink.
      const headers = req.headers;
      if (headers && typeof headers === 'object') {
        for (const key of Object.keys(headers)) {
          if (REDACTED_HEADER.has(key.toLowerCase())) {
            headers[key] = '[REDACTED]';
          }
        }
      }
      // `event.request.cookies` is a SEPARATE field from the `Cookie` header:
      // Sentry's default `requestDataIntegration` (include.cookies=true) parses
      // the request cookies into a dict `{ access_token, refresh_token, … }` —
      // our auth bearer credentials. The pino sink never emits a parsed-cookie
      // dict (it redacts the whole `Cookie` header), so to keep sink parity we
      // redact every cookie VALUE here (a parsed cookie value is never useful
      // observability, and any of them may be a bearer secret).
      const cookies = req.cookies;
      if (cookies && typeof cookies === 'object') {
        for (const key of Object.keys(cookies)) {
          cookies[key] = '[REDACTED]';
        }
      }
      // `event.request.data` is the CAPTURED REQUEST BODY (Sentry's default
      // httpIntegration buffers it). It carries the invite/reset token, the
      // cleartext password, and owner PII (national_id/phone) on the auth +
      // owner endpoints. The pino sink redacts exactly these leaf keys
      // (LOG_REDACT_PATHS req.body.*); we mirror that here. An OBJECT body has
      // its sensitive leaf VALUES redacted (route/shape kept for debugging); a
      // STRING/raw body is opaque-redacted whole (the credential could be
      // anywhere in it and a raw body is never observability we need).
      const data = req.data;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const key of Object.keys(data as Record<string, unknown>)) {
          if (SENSITIVE_BODY_KEY.has(key.toLowerCase())) {
            (data as Record<string, unknown>)[key] = '[REDACTED]';
          }
        }
      } else if (typeof data === 'string' && data.length > 0) {
        req.data = '[REDACTED]';
      }
    }

    // ---- top-level message / transaction name --------------------------
    if (typeof event.message === 'string') {
      event.message = scrubUrlForLog(event.message);
    }
    if (typeof event.transaction === 'string') {
      event.transaction = scrubUrlForLog(event.transaction);
    }

    // ---- exception values + stack frames -------------------------------
    // The single most common egress: an error thrown on `/sign/:token`
    // interpolates the URL into its message → `exception.values[].value`.
    const exValues = event.exception?.values;
    if (Array.isArray(exValues)) {
      for (const ex of exValues) {
        if (ex && typeof ex.value === 'string') {
          ex.value = scrubUrlForLog(ex.value);
        }
      }
    }

    // ---- breadcrumbs ----------------------------------------------------
    if (Array.isArray(event.breadcrumbs)) {
      for (const crumb of event.breadcrumbs) {
        if (!crumb) continue;
        if (typeof crumb.message === 'string') {
          crumb.message = scrubUrlForLog(crumb.message);
        }
        const data = crumb.data;
        if (data && typeof data['url'] === 'string') {
          data['url'] = scrubUrlForLog(data['url']);
        }
      }
    }

    // ---- transaction span data (OTel http spans) -----------------------
    const spans = event.spans;
    if (Array.isArray(spans)) {
      for (const span of spans) {
        const data = span?.data;
        if (data && typeof data === 'object') {
          for (const key of URL_SPAN_DATA_KEY) {
            const v = (data as Record<string, unknown>)[key];
            if (typeof v === 'string') {
              (data as Record<string, unknown>)[key] = scrubUrlForLog(v);
            }
          }
        }
      }
    }
  } catch {
    // Fail-open: never let scrubbing throw inside the SDK pipeline.
    return event;
  }
  return event;
}

// Normalise every `query_string` shape (`string | { [k]: string } |
// Array<[k, v]>`) THROUGH the canonical string scrubber (serialise → scrub →
// re-shape) so there is exactly one place that decides what is sensitive.
function scrubQueryString(
  qs: string | { [key: string]: string } | Array<[string, string]> | undefined,
): typeof qs {
  if (typeof qs === 'string') {
    return qs.length > 0 ? scrubQueryFragment(qs) : qs;
  }
  if (Array.isArray(qs)) {
    const scrubbed = scrubQueryFragment(qs.map(([k, v]) => `${k}=${v}`).join('&'));
    return scrubbed.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      return (eq === -1 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)]) as [string, string];
    });
  }
  if (qs && typeof qs === 'object') {
    const scrubbed = scrubQueryFragment(
      Object.entries(qs)
        .map(([k, v]) => `${k}=${v}`)
        .join('&'),
    );
    const out: { [key: string]: string } = {};
    for (const pair of scrubbed.split('&')) {
      const eq = pair.indexOf('=');
      if (eq !== -1) out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return out;
  }
  return qs;
}

// Run the canonical URL scrubber over a bare query fragment (no leading `?`).
// `scrubUrlForLog` only scrubs query values AFTER a `?`, so prefix a synthetic
// one, scrub, then strip it back off. Keeps the `?token=…` masking identical to
// the request-logger sink (single source of truth).
function scrubQueryFragment(fragment: string): string {
  return scrubUrlForLog(`?${fragment}`).slice(1);
}

// Guard: only initialise Sentry (and its OpenTelemetry auto-instrumentation)
// when a DSN is configured. Without a DSN, Sentry.init() still wires up the
// OTel instrumentation + event pipeline (prepareEvent/normalize/stack-trace),
// which — under a tight error/I/O loop on a request path — amplifies into a
// CPU spin that blocks the event loop (observed via --prof on the tenant-OTP
// path: heavy @sentry/core sendEnvelope/captureException + UVException/ntdll).
// A DSN-less deploy gains nothing from initialising it. (QA-OTP-1 root-cause.)
const sentryDsn = process.env['SENTRY_DSN_API'];
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env['NODE_ENV'] ?? 'development',
    tracesSampleRate: 0.1,
    // SEC-TOKEN-SENTRY (#9): scrub credential-bearing URLs/tokens from EVERY
    // error event AND every trace/transaction before it leaves the process.
    beforeSend: (event) => scrubEventCredentials(event),
    beforeSendTransaction: (event) => scrubEventCredentials(event),
  });
}

// Forward pg-pool resilience-guard events (Neon idle drop, network blip,
// any client-level error pg-pool reaps) to Sentry as breadcrumbs.
// Breadcrumb — not captureException — because the guard ALREADY contained
// the failure; this is observability for chronic-rate detection, not a
// surfaced error. Only err.message is forwarded (pg connection-layer,
// no query text / PII — enforced at the @emapp/db boundary).
// TODO(metrics): pool_client_reaped_total{pool} counter when a metrics
// stack is adopted (no prom-client / OpenTelemetry today).
setPoolErrorObserver((event) => {
  Sentry.addBreadcrumb({
    category: 'db.pool',
    level: 'warning',
    message: `${event.pool} client error (reaped): ${event.message}`,
    data: { pool: event.pool, source: event.source },
  });
});
