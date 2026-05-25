import type { SignatureRequest, SignatureRequestStatus } from '@emapp/shared-types';

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
 */

const STATUS_LABELS_HE: Record<SignatureRequestStatus, string> = {
  pending: 'ממתין לחתימה',
  signed: 'חתום',
  cancelled: 'בוטל',
};

const STATUS_LABELS_EN: Record<SignatureRequestStatus, string> = {
  pending: 'Pending',
  signed: 'Signed',
  cancelled: 'Cancelled',
};

const STATUS_COLORS: Record<SignatureRequestStatus, SignatureRequestViewModel['statusColor']> = {
  pending: 'amber',
  signed: 'emerald',
  cancelled: 'gray',
};

const TERMINAL_STATES = new Set<SignatureRequestStatus>(['signed', 'cancelled']);
/** D.12 LAW + signature-requests.service.ts:cancel() — only `pending`
 *  is cancellable. Server returns 409 `signature_request_already_signed`
 *  on cancelled-signed; cancelled→cancelled is idempotent (200). */
const CANCELLABLE_STATES = new Set<SignatureRequestStatus>(['pending']);

export function toSignatureRequestViewModel(
  r: SignatureRequest,
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
    statusColor: STATUS_COLORS[r.status],
    isCancellable: CANCELLABLE_STATES.has(r.status) && !isExpired,
    isTerminal: TERMINAL_STATES.has(r.status),
    isExpired,
    expiresAtIso: r.expiresAt.toISOString(),
    expiresRelative: formatRelative(r.expiresAt, locale),
    createdRelative: formatRelative(r.createdAt, locale),
    signedRelative: r.signedAt ? formatRelative(r.signedAt, locale) : null,
    cancelledRelative: r.cancelledAt ? formatRelative(r.cancelledAt, locale) : null,
  };
}

export function toSignatureRequestViewModels(
  items: SignatureRequest[],
  locale: 'he' | 'en' = 'he',
  now: Date = new Date(),
): SignatureRequestViewModel[] {
  return items.map((r) => toSignatureRequestViewModel(r, locale, now));
}

export const SIGNATURE_REQUEST_STATUS_LABELS_HE = STATUS_LABELS_HE;
export const SIGNATURE_REQUEST_STATUS_LABELS_EN = STATUS_LABELS_EN;
export const SIGNATURE_REQUEST_STATUS_COLORS = STATUS_COLORS;
export const SIGNATURE_REQUEST_TERMINAL_STATES = TERMINAL_STATES;
export const SIGNATURE_REQUEST_CANCELLABLE_STATES = CANCELLABLE_STATES;
