import {
  CreateOwnerInput,
  OwnerSearchInput,
  UpdateOwnerInput,
  type CreateOwner,
  type OwnerSearch,
  type UpdateOwner,
} from '@emapp/shared-types';
import { isValidIsraeliId, isValidIsraeliPhone } from '@emapp/validators';

// shared-types stays PURE (no @emapp deps). The Israeli-ID MOD-10 checksum
// and phone validity are layered HERE so a bad national_id/phone fails at
// the API boundary as a D.16 `validation_error` (the ZodValidationPipe
// emits that code). The structural 9-digit / length checks already ran in
// the shared schema; these refines add the semantic checks. The FE
// composes the same @emapp/validators on top of the shared schema.

const checkId = (v: string | undefined): boolean => v === undefined || isValidIsraeliId(v);
const checkPhone = (v: string | null | undefined): boolean =>
  v === undefined || v === null || isValidIsraeliPhone(v);

// S3a — national_id is OPTIONAL on create (owner SHELLS). `checkId` already
// passes `undefined` through; the checksum only runs when a value is present.
export const CreateOwnerDto = CreateOwnerInput.refine((d) => checkId(d.national_id), {
  path: ['national_id'],
  message: 'national_id failed the Israeli ID checksum',
}).refine((d) => checkPhone(d.phone), {
  path: ['phone'],
  message: 'phone is not a valid Israeli number',
});

export const UpdateOwnerDto = UpdateOwnerInput.refine((d) => checkId(d.national_id), {
  path: ['national_id'],
  message: 'national_id failed the Israeli ID checksum',
}).refine((d) => checkPhone(d.phone), {
  path: ['phone'],
  message: 'phone is not a valid Israeli number',
});

export const OwnerSearchDto = OwnerSearchInput.refine((d) => checkId(d.national_id), {
  path: ['national_id'],
  message: 'national_id failed the Israeli ID checksum',
}).refine((d) => checkPhone(d.phone), {
  path: ['phone'],
  message: 'phone is not a valid Israeli number',
});

export type { CreateOwner, UpdateOwner, OwnerSearch };
