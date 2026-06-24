import type {
  SignatureRequest,
  SignatureRequestListItem,
  SignatureRequestStatus,
} from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { SignatureRequestViewModel } from '@/models/signature-request.vm';

/**
 * Wire → ViewModel adapter for SignatureRequest (docs/05 §9.8 +
 * D.12 LAW + signature-request.ts schema).
 *
 * Labels are owned HERE (not in i18n message files) because they map
 * 1:1 from a locked enum to product-specific Hebrew terminology —
 * splitting the label set across i18n + the schema would let a future
 * enum change silently bypass the UI.
 *
 * ONE adapter, TWO wire shapes (Slice 3): the base `SignatureRequest`
 * (detail / create / cancel surfaces) and the LIST row
 * `SignatureRequestListItem`, which ADDS the display-context fields
 * (`projectName` / `apartmentLabel` / `documentName` / `ownerDisplay`). The
 * adapter reads those fields when present and defaults them to `null` for the
 * base shape — so the list legibility data and the detail path share ONE
 * mapping (no second implementation), and a base-shape row simply carries the
 * neutral fallbacks. `ownerDisplay` is whatever the SERVER returned (masked =
 * already `null`); the adapter NEVER unmasks.
 */

const STATUS_LABELS_HE: Record<SignatureRequestStatus, string> = {
  pending: 'ממתין לחתימה',
  signed: 'חתום',
  cancelled: 'בוטל',
  expired: 'פג תוקף',
};

const STATUS_LABELS_EN: Record<SignatureRequestStatus, string> = {
  pending: 'Pending',
  signed: 'Signed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

const STATUS_INTENTS: Record<SignatureRequestStatus, SignatureRequestViewModel['intent']> = {
  pending: 'warning',
  signed: 'success',
  cancelled: 'neutral',
  expired: 'danger',
};

const TERMINAL_STATES = new Set<SignatureRequestStatus>(['signed', 'cancelled']);
/** D.12 LAW + signature-requests.service.ts:cancel() — only `pending`
 *  is cancellable. Server returns 409 `signature_request_already_signed`
 *  on cancelled-signed; cancelled→cancelled is idempotent (200). */
const CANCELLABLE_STATES = new Set<SignatureRequestStatus>(['pending']);

/** The base shape OR the enriched list-item shape. Using a union (not a second
 *  adapter) keeps ONE mapping for both surfaces; the optional reads below pull
 *  the display context only when the list endpoint provided it. */
type SignatureRequestWire = SignatureRequest | SignatureRequestListItem;

/** Pull a nullable display-context field if the wire row carried it (list item),
 *  else `null` (base detail row). Pure read — never derives PII. */
function displayField(r: SignatureRequestWire, key: keyof SignatureRequestListItem): string | null {
  const v = (r as Partial<SignatureRequestListItem>)[key];
  return typeof v === 'string' ? v : null;
}

export function toSignatureRequestViewModel(
  r: SignatureRequestWire,
  locale: 'he' | 'en' = 'he',
  now: Date = new Date(),
): SignatureRequestViewModel {
  const labels = locale === 'he' ? STATUS_LABELS_HE : STATUS_LABELS_EN;
  const isExpired = r.status === 'pending' && r.expiresAt.getTime() <= now.getTime();
  return {
    id: r.id,
    documentId: r.documentId,
    ownerId: r.ownerId,
    status: r.status,
    statusLabel: labels[r.status],
    intent: STATUS_INTENTS[r.status],
    isCancellable: CANCELLABLE_STATES.has(r.status) && !isExpired,
    isTerminal: TERMINAL_STATES.has(r.status),
    isExpired,
    expiresAtIso: r.expiresAt.toISOString(),
    createdAtMs: r.createdAt.getTime(),
    expiresRelative: formatRelative(r.expiresAt, locale),
    createdRelative: formatRelative(r.createdAt, locale),
    signedRelative: r.signedAt ? formatRelative(r.signedAt, locale) : null,
    cancelledRelative: r.cancelledAt ? formatRelative(r.cancelledAt, locale) : null,
    // Slice-3 display context — present only on the list-item wire shape; the
    // base detail row falls through to `null`. `ownerDisplay` is the server's
    // already-masked value (null for a caller lacking `view_owner_pii`); the
    // adapter passes it through verbatim and NEVER reconstructs a name.
    projectName: displayField(r, 'projectName'),
    apartmentLabel: displayField(r, 'apartmentLabel'),
    documentName: displayField(r, 'documentName'),
    ownerDisplay: displayField(r, 'ownerDisplay'),
  };
}

export function toSignatureRequestViewModels(
  items: SignatureRequestWire[],
  locale: 'he' | 'en' = 'he',
  now: Date = new Date(),
): SignatureRequestViewModel[] {
  return items.map((r) => toSignatureRequestViewModel(r, locale, now));
}

export const SIGNATURE_REQUEST_STATUS_LABELS_HE = STATUS_LABELS_HE;
export const SIGNATURE_REQUEST_STATUS_LABELS_EN = STATUS_LABELS_EN;
export const SIGNATURE_REQUEST_STATUS_INTENTS = STATUS_INTENTS;
export const SIGNATURE_REQUEST_TERMINAL_STATES = TERMINAL_STATES;
export const SIGNATURE_REQUEST_CANCELLABLE_STATES = CANCELLABLE_STATES;
