import { Body, Query, SetMetadata } from '@nestjs/common';
import type { ZodSchema } from 'zod';

import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * S0-SEC — input-validation guarantee, declarative form.
 *
 * `@ZodBody(schema)` / `@ZodQuery(schema)` bundle the project's
 * `ZodValidationPipe` with the `@Body()` / `@Query()` parameter decorator so a
 * new endpoint validates its body/query BY CONSTRUCTION (the pipe is part of
 * the decorator — there is no way to declare the arg without it). They are the
 * forward-looking migration target; the existing inline
 * `@Body(new ZodValidationPipe(schema))` form is preserved verbatim and is
 * recognised as equally valid by the coverage guard.
 *
 * The opt-out markers below (`@RawBody` / `@NoValidation`) are for the four
 * intentional exceptions that cannot carry a Zod schema (raw-byte upload,
 * cookie-only refresh/logout). They set handler metadata AND are recognised by
 * the static coverage guard (`input-validation-coverage.spec.ts`), so an
 * unguarded `@Body()`/`@Query()` arg fails CI unless it is explicitly,
 * justifiably opted out here.
 */

export const RAW_BODY_KEY = 'rawBody';
export const NO_VALIDATION_KEY = 'noValidation';

/** Validate the request body against `schema` (D.16 `validation_error` on fail). */
export const ZodBody = (schema: ZodSchema): ParameterDecorator =>
  Body(new ZodValidationPipe(schema));

/** Validate the query string against `schema` (D.16 `validation_error` on fail). */
export const ZodQuery = (schema: ZodSchema): ParameterDecorator =>
  Query(new ZodValidationPipe(schema));

/**
 * Explicit opt-out: this handler takes a RAW (non-Zod-able) body — e.g. the
 * `application/octet-stream` byte upload on documents `:id/content`, where the
 * integrity gate (size + sha256 vs the create-declared values) IS the
 * validation. The NUL/UTF-8 fail-closed guard in the global pipe still runs.
 */
export const RawBody = (): MethodDecorator => SetMetadata(RAW_BODY_KEY, true);

/**
 * Explicit opt-out: this handler deliberately has NO Zod-validated body/query —
 * e.g. auth + provider-auth `refresh` / `logout`, which read only the
 * httpOnly refresh cookie and carry no client-supplied body.
 */
export const NoValidation = (): MethodDecorator => SetMetadata(NO_VALIDATION_KEY, true);
