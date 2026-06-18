// PostgreSQL cannot store a NUL (U+0000) and rejects unpaired surrogates /
// invalid UTF-8 with SQLSTATE 22021. Such input must fail as a clean D.16
// `validation_error` at the validation choke-point — it must never reach the
// DB and surface as a 500 (ISO: never a 5xx on client input). No literal
// control chars in source — codepoints are checked numerically.
//
// Extracted from zod-validation.pipe.ts so the per-route `ZodValidationPipe`
// AND the `GlobalZodValidationPipe` (S0-SEC) share ONE implementation — the
// global pipe applies this fail-closed guard to EVERY body/query/param at a
// single choke-point (previously only opt-in routes were covered).

function stringIsUnstorable(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 0) return true; // NUL — Postgres text cannot hold it
    // Unpaired surrogate (lone high/low) ⇒ invalid UTF-8 for Postgres.
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (Number.isNaN(n) || n < 0xdc00 || n > 0xdfff) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // lone low surrogate
    }
  }
  return false;
}

export function hasUnstorableText(v: unknown, depth = 0): boolean {
  // FAIL-CLOSED: a safety guard must never silently pass un-scanned input.
  // Every Zod body schema is `.strict()` and shallow (<= ~4 levels), so
  // anything past this generous bound is pathological / adversarial -> reject
  // rather than let it reach Postgres.
  if (depth > 8) return true;
  if (typeof v === 'string') return stringIsUnstorable(v);
  // Raw binary (the documents `:id/content` 50MB octet-stream Buffer) is NOT
  // text and is NEVER the guard's target. Without this short-circuit a Buffer
  // would fall into the `Object.values` branch below — a `typeof 'object'`,
  // non-Array value — materialising a ~52M-element array per upload (CPU + heap
  // DoS) only to scan byte-NUMBERS that `stringIsUnstorable` never inspects.
  // The byte stream is integrity-checked (size + sha256) downstream, not here.
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  if (Array.isArray(v)) return v.some((x) => hasUnstorableText(x, depth + 1));
  if (v && typeof v === 'object') {
    return Object.values(v as Record<string, unknown>).some((x) => hasUnstorableText(x, depth + 1));
  }
  return false;
}
