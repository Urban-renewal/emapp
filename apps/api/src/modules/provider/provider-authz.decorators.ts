import 'reflect-metadata';

import type { ProviderAction } from '../../common/authz/policy';

// Metadata key read by ProviderAuthorizationGuard. Using reflect-metadata
// directly (not Nest SetMetadata/Reflector) so the guard stays a zero-DI
// `new ProviderAuthorizationGuard()` in @UseGuards — symmetric with the
// org-tier authz.decorators.ts.
export const PROVIDER_AUTHZ_ACTION = 'provider-authz:action';

/**
 * D.49 — method decorator declaring the `ProviderAction` a handler needs.
 *
 * The guard DEFAULTS to `'read'` when this is absent, so every existing
 * (and future) GET endpoint stays correctly gated with no annotation —
 * read is the safe default. A WRITE endpoint MUST carry
 * `@RequireProviderAction('write')`; the guard then consults
 * `canProvider(role, 'provider', 'write')` and fails closed (403) for any
 * role the matrix does not grant write.
 *
 * Forgetting it on a write route does NOT open a hole — it would gate the
 * write against `read`, which today resolves to the same `provider_admin`
 * set, but the moment a read-only Provider role exists the annotation
 * becomes load-bearing. Pinned by the guard spec.
 */
export function RequireProviderAction(action: ProviderAction): MethodDecorator {
  return (_t, _k, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(PROVIDER_AUTHZ_ACTION, action, descriptor.value as object);
  };
}
