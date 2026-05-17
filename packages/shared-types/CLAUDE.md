# @emapp/shared-types

Shared TypeScript types imported by both BE and FE.

## Currently empty
Phase 1+ will export domain types (Project, Owner, Apartment, etc.)
and the API envelope types (`ApiResponse<T>`, `PagedResponse<T>`).

## Rules
- No runtime code, only `type` / `interface` / `enum` exports.
- No imports from other `@emapp/*` packages (to avoid circular deps).
- Every exported type must be documented with a one-line JSDoc.
- Changes here are a breaking change for both apps — coordinate.
