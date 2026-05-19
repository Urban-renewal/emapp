import 'reflect-metadata';

import type { Action, Resource } from './policy';

// Metadata keys read by AuthorizationGuard. Using reflect-metadata
// directly (not Nest SetMetadata/Reflector) so the guard can be a
// zero-DI `new AuthorizationGuard()` in @UseGuards — no per-module wiring,
// one enforcement point.
export const AUTHZ_RESOURCE = 'authz:resource';
export const AUTHZ_ACTION = 'authz:action';

/**
 * Class decorator — declares the D.17 resource a controller governs.
 * EVERY domain controller MUST carry this; AuthorizationGuard fails
 * CLOSED (403) if it runs without it, so a new slice cannot ship an
 * un-policed endpoint by omission.
 */
export function AuthzResource(resource: Resource): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(AUTHZ_RESOURCE, resource, target);
  };
}

/**
 * Method decorator — overrides the HTTP-verb→action default for the few
 * endpoints whose verb does not match their semantic action
 * (e.g. POST /owners/search is a READ; POST /notifications/:id/read is an
 * UPDATE).
 */
export function AuthzAction(action: Action): MethodDecorator {
  return (_t, _k, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(AUTHZ_ACTION, action, descriptor.value as object);
  };
}
