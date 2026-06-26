/**
 * Pino redaction policy for the HTTP request logger (extracted from
 * `app.module.ts` so it is unit-testable — see `log-redact.spec.ts`).
 *
 * Two layers:
 *  1. `paths` — leaf fields the censor is applied to. Credentials
 *     (authorization / cookie / referer / password / token / signature) and PII
 *     (national_id / phone) never reach the logs. The request URL is ALSO
 *     covered — see SEC-TOKEN-LOG below.
 *  2. `censor` — the replacement function, applied per redacted leaf. It is
 *     PATH-AWARE (pino passes the leaf's path as the 2nd arg): for the request
 *     `url`/`query` it surgically scrubs only the embedded credential (the
 *     `/sign/<jwt>` path-segment + sensitive query values) and KEEPS the route
 *     visible for observability; every other redacted leaf (a credential/PII
 *     field) is fully replaced with `[REDACTED]`.
 *
 * SEC M-2: `referer`/`referrer` are redacted because the password-reset link
 * carries the single-use token in a query param (`/reset-password?token=…`);
 * an unredacted referer would leak that credential into the logs.
 *
 * SEC-TOKEN-LOG (red-team 2026-06-25, HIGH): the signing JWT — the apartment
 * owner's BEARER credential for the no-auth `/sign/:token` route — landed in
 * pino's `req.url` field verbatim on every GET/POST. `req.params.token` was
 * redacted but `req.url` was NOT, and a pino censor only runs on its configured
 * `paths`, so the `/sign/[REDACTED]` regex never fired on the URL — the in-code
 * "token never in logs" guarantee was false. Fix: add `req.url` to the paths
 * AND make the censor path-aware, so the route stays legible while the token is
 * masked (a blanket `[REDACTED]` on every URL would blind ops to which endpoint
 * was hit — that would trade one defect for an observability regression).
 */

/** Matches the `/sign/<jwt>` path-segment (the signing bearer token in a URL). */
export const SIGN_TOKEN_URL_REGEX = /\/sign\/[\w-]+\.[\w-]+\.[\w-]+/g;

/**
 * Query-param KEYS whose VALUE is a credential and must be scrubbed from a
 * logged URL (defense-in-depth — no API endpoint takes these in a query string
 * today, but a future one must never leak a secret via the request logger).
 * Benign keys (`limit`, `cursor`, `status`, …) are KEPT for observability.
 */
const SENSITIVE_QUERY_KEY =
  /^(token|otp|code|secret|password|signature|api[_-]?key|key|access[_-]?token|refresh[_-]?token)$/i;

/** Leaf field names the censor scrubs surgically (route preserved). */
const URL_LEAF = new Set(['url', 'originalUrl', 'query']);

/**
 * Surgically scrub credentials EMBEDDED in a logged URL string while preserving
 * the route + benign query keys/values for observability:
 *  - the `/sign/<jwt>` path-segment token  → `/sign/[REDACTED]`
 *  - a `?<sensitive-key>=<value>` query value → `=[REDACTED]` (key kept)
 * Exported for direct testing.
 */
export function scrubUrlForLog(url: string): string {
  SIGN_TOKEN_URL_REGEX.lastIndex = 0;
  let out = url.replace(SIGN_TOKEN_URL_REGEX, '/sign/[REDACTED]');
  SIGN_TOKEN_URL_REGEX.lastIndex = 0;
  const qIdx = out.indexOf('?');
  if (qIdx !== -1) {
    const path = out.slice(0, qIdx);
    const query = out.slice(qIdx + 1);
    if (query.length > 0) {
      const scrubbed = query
        .split('&')
        .map((pair) => {
          const eq = pair.indexOf('=');
          if (eq === -1) return pair;
          const key = pair.slice(0, eq);
          return SENSITIVE_QUERY_KEY.test(key) ? `${key}=[REDACTED]` : pair;
        })
        .join('&');
      out = `${path}?${scrubbed}`;
    }
  }
  return out;
}

/**
 * The censor applied to every redacted leaf. PATH-AWARE: pino passes the leaf
 * path as the 2nd arg. The request `url`/`query` is scrubbed surgically (route
 * kept); every other leaf is a credential/PII field → fully `[REDACTED]`.
 * Back-compatible: when called WITHOUT a path (direct unit calls / legacy), a
 * `/sign/<jwt>` string is surgically masked and anything else fully redacted.
 * Exported for direct testing.
 */
export function logRedactCensor(value: unknown, path?: readonly string[]): unknown {
  const leaf = path && path.length > 0 ? path[path.length - 1] : undefined;
  if (leaf !== undefined && URL_LEAF.has(leaf)) {
    return typeof value === 'string' ? scrubUrlForLog(value) : value;
  }
  if (typeof value === 'string') {
    SIGN_TOKEN_URL_REGEX.lastIndex = 0;
    const matched = SIGN_TOKEN_URL_REGEX.test(value);
    SIGN_TOKEN_URL_REGEX.lastIndex = 0;
    if (matched) return value.replace(SIGN_TOKEN_URL_REGEX, '/sign/[REDACTED]');
  }
  return '[REDACTED]';
}

/** Leaf paths the censor is applied to on every request log line. */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  // SEC M-2 — the referer/referrer header can carry a token-bearing URL
  // (the password-reset link is `/reset-password?token=…`). Cookie was already
  // redacted; referer was the remaining credential-in-logs gap.
  'req.headers.referer',
  'req.headers.referrer',
  'req.body.password',
  'req.body.token',
  // PII — owner create/update/search bodies (Doc07: never log PII).
  'req.body.national_id',
  'req.body.phone',
  // Phase 5 (docs/03 §9): signing token NEVER in logs, not even partial.
  'req.params.token',
  // SVG signature payload is encrypted at rest (D.12 LAW); keep it out of logs.
  'req.body.signatureSvg',
  // SEC-TOKEN-LOG (red-team 2026-06-25, HIGH) — the signing JWT lands in
  // `req.url` verbatim; the path-aware censor masks the `/sign/<jwt>` segment
  // (and sensitive query values) while keeping the route legible.
  // `req.query.token` is belt-and-suspenders for a token serialized as a query
  // object rather than inside the URL string.
  'req.url',
  'req.query.token',
];

/** The pino `redact` option object. */
export const LOG_REDACT = {
  paths: [...LOG_REDACT_PATHS],
  censor: logRedactCensor,
};
