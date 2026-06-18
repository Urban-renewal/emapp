import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * S0-SEC — input-validation COVERAGE guard (the load-bearing deliverable).
 *
 * Every endpoint is validated by convention today (`new ZodValidationPipe(s)`
 * per route) — 100% present, but NOT enforced by construction. A future
 * endpoint could silently `@Body() dto` with no pipe and trust the wire.
 *
 * This spec statically scans every `*.controller.ts` under src/ (same
 * static-scan, no-import posture as `api-docs-coverage.spec.ts` and
 * `agent-capability-guard.spec.ts`) and asserts: EVERY route handler that
 * takes a `@Body()` or `@Query()` argument is guarded by one of —
 *   1. an inline pipe on the parameter — `@Body(new ZodValidationPipe(s))`,
 *      `@Body(UuidParam)`, `@Query(new ZodValidationPipe(s))`, …;
 *   2. the declarative form — `@ZodBody(s)` / `@ZodQuery(s)`;
 *   3. a method-level `@UsePipes(new ZodValidationPipe(s))`;
 *   4. an EXPLICIT, justified opt-out marker — `@RawBody()` / `@NoValidation()`.
 * An unguarded `@Body()`/`@Query()` arg with none of the above FAILS the build.
 *
 * Scope note: `@Param()` is intentionally NOT required to carry a schema —
 * params are opaque ids guarded by the `UuidParam` pipe where they matter, and
 * the global pipe's NUL/UTF-8 guard covers every param value regardless. The
 * guard keys on body/query because those are the structured client payloads.
 *
 * NOTE: controllers are read as TEXT (regex), never imported — importing them
 * would pull the whole Nest DI graph into a static architecture test.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function collectControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectControllerFiles(full));
    } else if (entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * One route handler: the contiguous decorator-block + method-signature text,
 * from the first decorator of its block through the closing `)` of its
 * parameter list. Carries everything the guard needs to evaluate in isolation.
 */
interface Handler {
  file: string;
  name: string;
  /** decorators above the method + the full parameter list, as raw text */
  block: string;
}

const ROUTE_DECORATOR = /@(?:Get|Post|Patch|Put|Delete)\(/;

/**
 * Split a controller source into per-handler blocks. We find each route
 * decorator, walk UP to the start of its contiguous decorator block (the first
 * line that is not blank / not a decorator / not a continuation), and walk DOWN
 * to the end of the method's parameter list (paren-balanced from the method
 * signature's opening `(`).
 */
function extractHandlers(file: string, src: string): Handler[] {
  const handlers: Handler[] = [];
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    if (!ROUTE_DECORATOR.test(lines[i] as string)) continue;

    // Walk UP to the first decorator of this contiguous block.
    let start = i;
    while (start > 0) {
      const prev = (lines[start - 1] as string).trim();
      if (prev.startsWith('@') || prev === '' || prev.startsWith('//') || prev.startsWith('*')) {
        start -= 1;
      } else {
        break;
      }
    }

    // Walk DOWN to the method signature line: `... name(` after the decorators.
    let sigLine = i;
    while (
      sigLine < lines.length &&
      !/[A-Za-z0-9_]+\s*\(/.test(stripDecorators(lines[sigLine] as string))
    ) {
      sigLine += 1;
    }
    if (sigLine >= lines.length) continue;

    // Capture the method name + paren-balance the parameter list.
    const sigText = lines.slice(sigLine).join('\n');
    // FALSE POSITIVE: the optional `(?:async\s+)?` prefix + a single greedy
    // `[A-Za-z0-9_]+` are non-overlapping (linear time), and the input is our
    // own checked-in controller source, never attacker-controlled.
    // eslint-disable-next-line security/detect-unsafe-regex
    const nameMatch = /(?:async\s+)?([A-Za-z0-9_]+)\s*\(/.exec(sigText);
    const name = nameMatch ? (nameMatch[1] as string) : '<unknown>';
    const open = sigText.indexOf('(', nameMatch ? nameMatch.index : 0);
    let depth = 0;
    let end = open;
    for (let p = open; p < sigText.length; p += 1) {
      const ch = sigText[p];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = p;
          break;
        }
      }
    }
    const params = sigText.slice(open, end + 1);
    const block = lines.slice(start, sigLine).join('\n') + '\n' + params;
    handlers.push({ file, name, block });

    i = sigLine; // continue scanning after this handler's decorators
  }
  return handlers;
}

/** Drop decorator-only prefixes so the method-signature heuristic is robust. */
function stripDecorators(line: string): string {
  const t = line.trim();
  if (t.startsWith('@')) return '';
  return line;
}

const HAS_BODY = /@Body\b/;
const HAS_QUERY = /@Query\b/;
// A @Body()/@Query() arg is INLINE-validated only when its OWN decorator carries
// a KNOWN validating pipe — the project's `ZodValidationPipe` (incl. the
// `UuidParam` singleton built from it). The token is matched specifically (NOT a
// generic `Pipe`/`Param` substring) so a non-validating pipe like
// `ParseArrayPipe` / `DefaultValuePipe` cannot satisfy the guard.
const VALIDATING_PIPE = '(?:ZodValidationPipe|UuidParam)';
const INLINE_BODY_PIPE = new RegExp(`@Body\\(\\s*[^)]*${VALIDATING_PIPE}`);
const INLINE_QUERY_PIPE = new RegExp(`@Query\\(\\s*[^)]*${VALIDATING_PIPE}`);
const ZOD_BODY = /@ZodBody\(/;
const ZOD_QUERY = /@ZodQuery\(/;
// Method-level @UsePipes(new ZodValidationPipe(Schema)) validates the BODY (the
// project convention — there is no @UsePipes that targets only the query). It
// is therefore credited to the body check ONLY, never the query check.
const USE_PIPES = /@UsePipes\(\s*new\s+ZodValidationPipe/;
// Opt-out markers suppress the BODY requirement ONLY (raw bytes / cookie-only).
// A @Query() on the same handler must STILL carry its own inline validation —
// an opt-out can never wave a query through.
const RAW_BODY = /@RawBody\(\)/;
const NO_VALIDATION = /@NoValidation\(\)/;

interface Violation {
  file: string;
  name: string;
  reason: string;
}

function auditHandler(h: Handler): Violation | null {
  const bodyOptedOut = RAW_BODY.test(h.block) || NO_VALIDATION.test(h.block);
  const usePipes = USE_PIPES.test(h.block);

  if (HAS_BODY.test(h.block)) {
    const bodyGuarded =
      INLINE_BODY_PIPE.test(h.block) || ZOD_BODY.test(h.block) || usePipes || bodyOptedOut;
    if (!bodyGuarded) {
      return {
        file: h.file,
        name: h.name,
        reason: 'has @Body() with no Zod pipe / @ZodBody / @UsePipes / @RawBody / @NoValidation',
      };
    }
  }
  if (HAS_QUERY.test(h.block)) {
    // @Query() is validated ONLY by its own inline pipe or @ZodQuery — never by
    // a body-level @UsePipes or a @RawBody/@NoValidation opt-out.
    const queryGuarded = INLINE_QUERY_PIPE.test(h.block) || ZOD_QUERY.test(h.block);
    if (!queryGuarded) {
      return {
        file: h.file,
        name: h.name,
        reason:
          'has @Query() with no Zod pipe / @ZodQuery (a body @UsePipes/opt-out does NOT cover @Query)',
      };
    }
  }
  return null;
}

describe('architecture: input-validation coverage (every body/query route is Zod-guarded or explicitly opted out)', () => {
  const files = collectControllerFiles(SRC_DIR);
  const handlers = files.flatMap((f) =>
    extractHandlers(f.slice(SRC_DIR.length + 1).replace(/\\/g, '/'), readFileSync(f, 'utf8')),
  );

  it('sanity: the controller scan found the known surface', () => {
    // If this collapses the parser regressed and the real assertion below
    // would pass vacuously.
    expect(handlers.length).toBeGreaterThanOrEqual(120);
    const withPayload = handlers.filter((h) => HAS_BODY.test(h.block) || HAS_QUERY.test(h.block));
    expect(withPayload.length).toBeGreaterThanOrEqual(40);
  });

  it('every @Body()/@Query() route handler is validated or explicitly opted out', () => {
    const violations = handlers.map(auditHandler).filter((v): v is Violation => v !== null);
    expect(
      violations.map((v) => `${v.file}#${v.name}  (${v.reason})`),
      `Route handler(s) take a @Body()/@Query() with NO validation and NO opt-out.\n` +
        `Add one of: @Body(new ZodValidationPipe(Schema)) / @ZodBody(Schema),\n` +
        `@Query(new ZodValidationPipe(Schema)) / @ZodQuery(Schema), a method-level\n` +
        `@UsePipes(new ZodValidationPipe(Schema)) — or, for a deliberate\n` +
        `exception (raw bytes / cookie-only), an explicit @RawBody()/@NoValidation()\n` +
        `marker with a justifying comment.\n\n` +
        violations.map((v) => `  - ${v.file}#${v.name}: ${v.reason}`).join('\n'),
    ).toEqual([]);
  });
});

/**
 * Self-tests for the guard's OWN audit logic — these lock the false-negative
 * holes a security review caught (opt-out / body-`@UsePipes` masking a real
 * `@Query()`; a generic non-validating pipe being accepted). They run the real
 * `auditHandler` against synthetic handler blocks so a future regression that
 * re-weakens the guard turns RED here, independent of the live controller tree.
 */
describe('guard self-test: false-negatives are closed', () => {
  const mk = (block: string): Handler => ({ file: 'synthetic.controller.ts', name: 'h', block });

  it('flags @Body() with NO validation', () => {
    expect(auditHandler(mk('@Post()\n(@Body() body: Dto)'))).not.toBeNull();
  });

  it('accepts @Body(new ZodValidationPipe(S))', () => {
    expect(auditHandler(mk('@Post()\n(@Body(new ZodValidationPipe(S)) body: Dto)'))).toBeNull();
  });

  it('accepts a body-only @UsePipes for @Body()', () => {
    expect(
      auditHandler(mk('@UsePipes(new ZodValidationPipe(S))\n@Post()\n(@Body() body: Dto)')),
    ).toBeNull();
  });

  it('a @RawBody() opt-out does NOT cover a co-located @Query()', () => {
    expect(
      auditHandler(mk('@RawBody()\n@Post()\n(@Body() raw: unknown, @Query() q: Q)')),
    ).not.toBeNull();
  });

  it('a body @UsePipes does NOT cover a co-located @Query()', () => {
    expect(
      auditHandler(
        mk('@UsePipes(new ZodValidationPipe(S))\n@Post()\n(@Body() b: B, @Query() q: Q)'),
      ),
    ).not.toBeNull();
  });

  it('a generic non-validating pipe (ParseArrayPipe) does NOT satisfy @Body()', () => {
    expect(auditHandler(mk('@Post()\n(@Body(new ParseArrayPipe()) body: Dto)'))).not.toBeNull();
  });

  it('accepts @Query(new ZodValidationPipe(S)) and @ZodQuery(S)', () => {
    expect(auditHandler(mk('@Get()\n(@Query(new ZodValidationPipe(S)) q: Q)'))).toBeNull();
    expect(auditHandler(mk('@Get()\n(@ZodQuery(S) q: Q)'))).toBeNull();
  });
});
