import type { SignatureRequestStatus } from '@emapp/shared-types';

/**
 * SignatureRequest ViewModel — Phase 5 (docs/03 §9, D.12 LAW).
 *
 * 3-state machine: pending → signed (terminal) | cancelled (terminal).
 *
 * - `isCancellable` is `true` only for `pending`; cancelling a signed
 *   row would unwind forensic evidence (the BE returns 409
 *   `signature_request_already_signed`).
 * - `isExpired` is a CLIENT-SIDE display flag; the BE enforces expiry
 *   at the atomic single-use guard on /sign/:token, but the manager UI
 *   should grey out pending-but-past-`expiresAt` rows so the manager
 *   doesn't think the link is still actionable.
 * - `signUrl` is ONLY populated on the create-response VM (one-shot
 *   reveal); the list/detail VM intentionally has no `signUrl` field —
 *   the token is a bearer credential and must not be persisted on the
 *   wire after the initial create. The manager copies it to the
 *   delivery channel of their choice at create time.
 */
export interface SignatureRequestViewModel {
  id: string;
  documentId: string;
  ownerId: string;
  status: SignatureRequestStatus;
  statusLabel: string;
  intent: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  isCancellable: boolean;
  isTerminal: boolean;
  isExpired: boolean;
  expiresAtIso: string;
  expiresRelative: string;
  createdRelative: string;
  signedRelative: string | null;
  cancelledRelative: string | null;
}
