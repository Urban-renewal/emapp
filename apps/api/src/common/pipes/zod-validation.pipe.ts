import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

// PostgreSQL cannot store a NUL (U+0000) and rejects unpaired surrogates /
// invalid UTF-8 with SQLSTATE 22021. Such input must fail as a clean D.16
// `validation_error` at THIS single choke-point — it must never reach the
// DB and surface as a 500 (ISO: never a 5xx on client input). One guard
// here covers every endpoint (defense-in-depth, single source). No literal
// control chars in source — codepoints are checked numerically.
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

function hasUnstorableText(v: unknown, depth = 0): boolean {
  // FAIL-CLOSED: a safety guard must never silently pass un-scanned
  // input. Every Zod body schema is `.strict()` and shallow (<= ~4
  // levels), so anything past this generous bound is pathological /
  // adversarial -> reject rather than let it reach Postgres.
  if (depth > 8) return true;
  if (typeof v === 'string') return stringIsUnstorable(v);
  if (Array.isArray(v)) return v.some((x) => hasUnstorableText(x, depth + 1));
  if (v && typeof v === 'object') {
    return Object.values(v as Record<string, unknown>).some((x) => hasUnstorableText(x, depth + 1));
  }
  return false;
}

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    if (hasUnstorableText(value)) {
      throw new BadRequestException({
        error: {
          code: 'validation_error',
          details: { _: ['contains NUL or invalid UTF-8'] },
        },
      });
    }
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'validation_error', details: result.error.flatten().fieldErrors },
      });
    }
    return result.data;
  }
}
