import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';

import { hasUnstorableText } from './unstorable-text';

/**
 * S0-SEC — global input-validation backstop (registered as `APP_PIPE`).
 *
 * The schema-level validation stays driven by the per-parameter pipe
 * (`ZodValidationPipe`, applied inline as `@Body(new ZodValidationPipe(s))` or
 * via the `@ZodBody`/`@ZodQuery` decorators). This GLOBAL pipe adds the one
 * guarantee that previously existed ONLY on opt-in routes: the fail-closed
 * NUL / invalid-UTF-8 reject, applied to EVERY TEXTUAL body / query / param at
 * a single choke-point — so even an endpoint that opts out of Zod (the four
 * documented exceptions) can never push a NUL or a lone surrogate into Postgres
 * and turn a bad request into a 5xx. Raw binary bodies (the octet-stream upload
 * on documents `:id/content`) are short-circuited in `hasUnstorableText` — they
 * are not text and are integrity-checked (size + sha256) downstream, not here.
 *
 * It runs BEFORE the per-route pipe in Nest's pipe chain (global pipes run
 * first), is idempotent with the per-route guard (both throw the identical
 * D.16 `validation_error` shape), and NEVER mutates the value it returns — so
 * existing endpoint behaviour is byte-identical. Custom-decorator args
 * (`@CurrentUser`, `@Req`, `@Res`, …) carry `type: 'custom'` and are passed
 * through untouched.
 */
@Injectable()
export class GlobalZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    // Only client-supplied request inputs are scanned. `custom` covers
    // param decorators like @CurrentUser / @Req / @Res — never client text.
    if (metadata.type === 'body' || metadata.type === 'query' || metadata.type === 'param') {
      if (hasUnstorableText(value)) {
        throw new BadRequestException({
          error: {
            code: 'validation_error',
            details: { _: ['contains NUL or invalid UTF-8'] },
          },
        });
      }
    }
    return value;
  }
}
