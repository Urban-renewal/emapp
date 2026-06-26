/**
 * Slice 2.5 — owner-state DTOs. Thin re-export of the canonical Zod schema from
 * `@emapp/shared-types` (the FE/BE source of truth) — never redefine the shape
 * here (shared-types CLAUDE.md rule).
 */
import { CreateOwnerStateSchema, type CreateOwnerState } from '@emapp/shared-types';

export const CreateOwnerStateDto = CreateOwnerStateSchema;
export type { CreateOwnerState };
