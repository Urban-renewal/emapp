import { OwnerEraseInput, type OwnerErase } from '@emapp/shared-types';

// P0.C1 — thin BE DTO for the erasure request body. The shape (an optional,
// non-PII compliance reason) is the shared-types source of truth; no extra
// semantic refinement is needed here (no Israeli-ID/phone checks — this body
// carries no PII).
export const OwnerEraseDto = OwnerEraseInput;
export type OwnerEraseBody = OwnerErase;
