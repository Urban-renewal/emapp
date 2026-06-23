/**
 * Wire → ViewModel adapter for Proposal (Autonomous Master Plan, Phase 1).
 *
 * PURE function — runs in the TanStack `select` (Doc 05 §9.8). It composes the
 * calm, user-framed copy from the neutral wire DATA. It reads ONLY the `kind`
 * and PII-free scalars from `evidence` (counts / ids / timestamps); it never
 * reads — and the wire never carries — a name / national_id / phone. The
 * adapter spec asserts the rendered VM contains NO PII even when a (malformed)
 * evidence snapshot tries to smuggle a PII-looking field.
 *
 * VOICE LAW (owner-mandated): the `whyTitle` is neutral-passive — "מוצע
 * להנפיק מחדש" / "Re-issue suggested" — the DECISION is the user's. NEVER
 * system-hero voice ("הנפקתי / I re-issued"). Lead-with-the-user-decision copy
 * lives at the page level ("N החלטות ממתינות לך"); the per-row CTA verb
 * ([אשר]/[דחה]) is the user's.
 *
 * Like the notification adapter, the HE/EN copy maps live INLINE here (not via
 * next-intl) because the adapter is a pure function outside the React tree. A
 * future kind that forgets a label falls through to the safe generic line — it
 * NEVER renders a raw `kind` string or PII.
 */
import type { ProposalApplyDelivery, ProposalView } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { DisplayLocale } from '@/lib/locale';
import type { ProposalApproveOutcome, ProposalViewModel } from '@/models/proposal.vm';

interface KindCopy {
  /** Neutral-passive "why" — the user's pending decision, never system-voice. */
  whyTitle: string;
  /** The APPROVE verb in the user's voice. */
  approveLabel: string;
}

/** Per-kind copy. Phase 1 ships ONE kind (`signature_request.reissue`); the
 *  generic fallback covers any future kind that lands before its label does. */
const KIND_COPY_HE: Record<string, KindCopy> = {
  'signature_request.reissue': {
    whyTitle: 'בקשת חתימה שפגה — מוצע להנפיק מחדש',
    approveLabel: 'אשר הנפקה מחדש',
  },
};

const KIND_COPY_EN: Record<string, KindCopy> = {
  'signature_request.reissue': {
    whyTitle: 'A signature request expired — re-issue suggested',
    approveLabel: 'Approve re-issue',
  },
};

const GENERIC_HE: KindCopy = { whyTitle: 'הצעה ממתינה לאישורך', approveLabel: 'אשר' };
const GENERIC_EN: KindCopy = {
  whyTitle: 'A suggestion is waiting for you',
  approveLabel: 'Approve',
};

/** Map a scopeType to a calm, PII-free scope label. The scope IDENTIFIES a
 *  record (a signature request / project) — never a person. */
function scopeLabel(scopeType: string, locale: DisplayLocale): string {
  const he: Record<string, string> = {
    signature_request: 'בקשת חתימה',
    project: 'פרויקט',
  };
  const en: Record<string, string> = {
    signature_request: 'Signature request',
    project: 'Project',
  };
  const map = locale === 'en' ? en : he;
  return map[scopeType] ?? (locale === 'en' ? 'Item' : 'פריט');
}

export function toProposalViewModel(
  p: ProposalView,
  locale: DisplayLocale = 'he',
): ProposalViewModel {
  const copyMap = locale === 'en' ? KIND_COPY_EN : KIND_COPY_HE;
  const generic = locale === 'en' ? GENERIC_EN : GENERIC_HE;
  const copy = copyMap[p.kind] ?? generic;
  return {
    id: p.id,
    kind: p.kind,
    whyTitle: copy.whyTitle,
    approveLabel: copy.approveLabel,
    scopeLabel: scopeLabel(p.scopeType, locale),
    createdRelative: formatRelative(p.createdAt, locale),
    createdAtIso: p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt),
  };
}

export function toProposalViewModels(
  items: ProposalView[],
  locale: DisplayLocale = 'he',
): ProposalViewModel[] {
  return items.map((p) => toProposalViewModel(p, locale));
}

/**
 * Map the wire `delivery` OUTCOME → the inbox CONFIRMATION model (the legibility
 * contract, G-QA rule #3). PURE + locale-agnostic: it decides the i18n KEY +
 * the toast TONE only; the client component resolves the actual copy via
 * next-intl (interpolating the translated channel label + masked recipient).
 *
 * Honest-by-construction: ONLY `state: 'sent'` maps to a `success` tone. Every
 * non-`sent` state maps to `neutral` (already_sent — idempotent, nothing new
 * went out) or `warning` (blocked / failed / ambiguous / no_channel — the
 * manager must NOT read these as a send). A `state: 'sent'` with NO channel is
 * incoherent (sent on... nothing?) → treated as `ambiguous`, never a false
 * success. The `sent` copy splits on whether a masked recipient is present
 * (email echoes `na***@domain`; sms/whatsapp do not) so the line stays
 * grammatical either way.
 */
export function toApproveOutcome(delivery: ProposalApplyDelivery): ProposalApproveOutcome {
  const { state, channel, recipient } = delivery;
  const base = { state, channel, recipient } as const;

  switch (state) {
    case 'sent': {
      // A `sent` with no channel can't be confirmed as a real send — be honest.
      if (channel === null) {
        return { ...base, tone: 'warning', messageKey: 'ambiguous' };
      }
      return {
        ...base,
        tone: 'success',
        messageKey: recipient ? 'sentWithRecipient' : 'sentNoRecipient',
      };
    }
    case 'already_sent':
      return { ...base, tone: 'neutral', messageKey: 'alreadySent' };
    case 'blocked':
      return { ...base, tone: 'warning', messageKey: 'blocked' };
    case 'no_channel':
      return { ...base, tone: 'warning', messageKey: 'noChannel' };
    case 'failed':
    case 'ambiguous':
      // Both mean "we can't confirm it went out" — one honest non-success line.
      return { ...base, tone: 'warning', messageKey: 'ambiguous' };
    default: {
      // Exhaustiveness guard — a new wire state lands here loud, never silent.
      const _exhaustive: never = state;
      return {
        state: _exhaustive,
        channel,
        recipient,
        tone: 'warning',
        messageKey: 'ambiguous',
      };
    }
  }
}
