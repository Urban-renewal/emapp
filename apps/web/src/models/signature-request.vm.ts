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
  /** Raw `created_at` epoch-ms — load-bearing for the flat list's client-side
   *  sort (newest / oldest first). `createdRelative` is display-only and cannot
   *  be ordered reliably (localized relative strings). */
  createdAtMs: number;
  expiresRelative: string;
  createdRelative: string;
  signedRelative: string | null;
  cancelledRelative: string | null;

  /**
   * Slice-3 DISPLAY CONTEXT — populated ONLY from the LIST endpoint's
   * `SignatureRequestListItem` wire row (BE #519). The detail / forensic
   * surfaces use the base `SignatureRequest` and resolve these to `null` (the
   * adapter's safe default), so a row that came through the detail path simply
   * renders the neutral fallbacks.
   *
   * - `projectName` / `apartmentLabel` / `documentName` — NON-PII same-org names
   *   the actor can already see. Nullable: a scope-less document or an archived
   *   apartment yields `null` and the row shows a neutral placeholder.
   * - `ownerDisplay` — the ONLY PII. MASKED-BY-DEFAULT: the SERVER returns `null`
   *   unless the caller holds `view_owner_pii` (it emits a literal SQL NULL for a
   *   masked caller, so cleartext never crosses the wire). The FE NEVER unmasks;
   *   it renders only what the server sent, wrapped in `<NameDisplay>`.
   *   national_id / phone NEVER appear here.
   */
  projectName: string | null;
  apartmentLabel: string | null;
  documentName: string | null;
  ownerDisplay: string | null;
}
