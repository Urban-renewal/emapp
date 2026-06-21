import type {
  ApartmentHoldout,
  ApartmentSignatureProgress,
  SignatureProgress,
} from '@emapp/shared-types';

/**
 * E2 Wave-2 E2.2-S3 — offline fixtures for the "תמונת מצב" board + drill-down.
 *
 * Mirrors the live `GET /projects/:id/signature-progress` (+ `/apartments` +
 * `/apartments/:apartmentId/holdouts`) wire shapes so the board renders fully
 * offline (`NEXT_PUBLIC_MSW=1`). All three are schema-gated in `samples.spec.ts`.
 *
 * The board is share-weighted (B0): `consentedPct` is BELOW the 80% target so the
 * ThresholdProgress shows the calm "below" (amber) state, and the apartment
 * drill-down has a `partial` row WITH a named holdout — exercising the offline
 * "who's stuck" reveal path. NO national_id / phone is ever present (B4).
 */
export const SAMPLE_SIGNATURE_PROGRESS: SignatureProgress = {
  totalApartments: 8,
  apartmentsConsented: 5,
  signaturesSigned: 5,
  signaturesPending: 3,
  targetSignaturePct: 80,
  consentedPct: 62,
  metThreshold: false,
  basis: 'share',
};

export const SAMPLE_APARTMENT_SIGNATURE_PROGRESS: ApartmentSignatureProgress[] = [
  {
    apartmentId: 'cccccccc-cccc-cccc-cccc-ccccccccccc1',
    number: '1',
    floor: 1,
    totalOwners: 2,
    signedOwners: 2,
    status: 'consented',
  },
  {
    apartmentId: 'cccccccc-cccc-cccc-cccc-ccccccccccc2',
    number: '2',
    floor: 1,
    totalOwners: 2,
    signedOwners: 1,
    status: 'partial',
  },
];

/** Holdouts for apartment `…ccc2` (the partial row). NAME-bearing PII — the only
 *  signature-progress fixture that carries owner names (B4). */
export const SAMPLE_APARTMENT_HOLDOUTS: ApartmentHoldout[] = [
  {
    ownerId: 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
    name: 'ישראל ישראלי',
    apartmentNumber: '2',
    // HB-5 fix — this apartment's own finalized agreement doc (the one-click
    // chase creates against THIS, so the offline create path targets apt 2's doc).
    signableDocumentId: 'ffffffff-ffff-ffff-ffff-fffffffffff2',
  },
];
