/**
 * Shared API client error class.
 *
 * §SOLID-M5 closure — was historically defined in `lib/api/projects.ts`
 * (S2 era — projects was the first entity, the class was inlined and
 * re-exported by 8 other entity files). Moved here so the import name
 * matches the concept and renaming `projects.ts` doesn't ripple.
 * `projects.ts` still re-exports for backward compatibility.
 */
export class ApiClientError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(env: { code: string; message?: string; details?: unknown }) {
    super(env.message ?? env.code);
    this.code = env.code;
    this.details = env.details;
    this.name = 'ApiClientError';
  }
}
