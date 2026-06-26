/**
 * Slice 2.7 — apartment-state DTOs. Thin re-export of the canonical Zod schema from
 * `@emapp/shared-types` (the FE/BE source of truth) — never redefine the shape here
 * (shared-types CLAUDE.md rule).
 */
import { CreateApartmentStateSchema, type CreateApartmentState } from '@emapp/shared-types';

export const CreateApartmentStateDto = CreateApartmentStateSchema;
export type { CreateApartmentState };
