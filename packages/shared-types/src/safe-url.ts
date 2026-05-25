import { z } from 'zod';

/**
 * Scheme-allowlisted URL schemas.
 *
 * P0 §RED-1 closure — the default `z.string().url()` accepts ANY
 * scheme (`javascript:`, `data:`, `file:`, `vbscript:`, etc.). If the
 * BE returns one of those (contract drift, compromised BE, future
 * feature that accepts user-supplied URLs), every FE consumer that
 * passes it to `<a href=...>` or `window.open()` executes attacker JS
 * in the user's session against the app origin.
 *
 * These schemas are used everywhere the FE renders a URL — presigned
 * R2 GET/PUT, signature signUrl, document downloadUrl. The BE mints
 * all of them today, but the schema is defense in depth: contract
 * drift fails parse → FE shows error, not attacker JS.
 *
 * - `HttpsUrlSchema` — requires `https:` only. Use for production-
 *   facing presigned URLs.
 * - `HttpOrHttpsUrlSchema` — allows `http:` too. Use ONLY for dev /
 *   localhost-style URLs (and prefer `HttpsUrlSchema` if you can).
 * - `WhatsAppDeepLinkSchema` — allows the `https:` wa.me URL shape
 *   that the BE produces for D.12 delivery. Same as `HttpsUrlSchema`
 *   today; named separately for clarity at the call site.
 */

const ALLOWED_PROTOCOLS_HTTPS = new Set(['https:']);
const ALLOWED_PROTOCOLS_HTTP_OR_HTTPS = new Set(['http:', 'https:']);

function makeUrlSchema(allowed: Set<string>) {
  return z
    .string()
    .url()
    .refine(
      (u) => {
        try {
          return allowed.has(new URL(u).protocol);
        } catch {
          return false;
        }
      },
      { message: 'url_scheme_not_allowed' },
    );
}

export const HttpsUrlSchema = makeUrlSchema(ALLOWED_PROTOCOLS_HTTPS);
export const HttpOrHttpsUrlSchema = makeUrlSchema(ALLOWED_PROTOCOLS_HTTP_OR_HTTPS);
export const WhatsAppDeepLinkSchema = HttpsUrlSchema;
