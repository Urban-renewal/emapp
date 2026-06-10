/**
 * Pino redaction policy for the HTTP request logger (extracted from
 * `app.module.ts` so it is unit-testable — see `log-redact.spec.ts`).
 *
 * Two layers:
 *  1. `paths` — leaf fields that are fully replaced by the censor. Credentials
 *     (authorization / cookie / referer / password / token / signature) and PII
 *     (national_id / phone) never reach the logs.
 *  2. `censor` — the replacement function. For a `/sign/<jwt>` URL it surgically
 *     replaces just the token segment (keeping the rest of the URL useful);
 *     everything else at a redacted path becomes `[REDACTED]`.
 *
 * SEC M-2: `referer`/`referrer` are redacted because the password-reset link
 * carries the single-use token in a query param (`/reset-password?token=…`);
 * an unredacted referer would leak that credential into the logs.
 */
export const SIGN_TOKEN_URL_REGEX = /\/sign\/[\w-]+\.[\w-]+\.[\w-]+/g;

/** The censor applied to every redacted leaf. Exported for direct testing. */
export function logRedactCensor(value: unknown): unknown {
  if (typeof value === 'string' && SIGN_TOKEN_URL_REGEX.test(value)) {
    // Reset lastIndex — the regex is global, .test() advances it.
    SIGN_TOKEN_URL_REGEX.lastIndex = 0;
    return value.replace(SIGN_TOKEN_URL_REGEX, '/sign/[REDACTED]');
  }
  return '[REDACTED]';
}

/** Leaf paths fully redacted from every request log line. */
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
  // The :token path param is redacted; the URL censor covers embedded URLs.
  'req.params.token',
  // SVG signature payload is encrypted at rest (D.12 LAW); keep it out of logs.
  'req.body.signatureSvg',
];

/** The pino `redact` option object. */
export const LOG_REDACT = {
  paths: [...LOG_REDACT_PATHS],
  censor: logRedactCensor,
};
