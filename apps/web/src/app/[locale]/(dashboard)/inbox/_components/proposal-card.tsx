'use client';

import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import type { ProposalViewModel } from '@/models/proposal.vm';

/**
 * Proposal card — one pending DECISION in the Approval Inbox (Autonomous Master
 * Plan, Phase 1). Modern design language (the build standard): a soft-radius,
 * flat, airy row led by a calm rounded icon-tile; the user-framed "why" is the
 * largest type; the teal CTA is reserved for the user's one-click [אשר].
 *
 * VOICE LAW: the copy frames the work as the USER's pending decision
 * ("ממתין להחלטתך" at the page; "מוצע להנפיק מחדש" here) — NEVER system-hero
 * voice. The two CTAs are the user's verbs: APPROVE (`vm.approveLabel`) and
 * REJECT (a quiet dismiss). The card renders NO PII — the VM carries only the
 * kind-derived copy + a PII-free scope label + a relative timestamp.
 */
export interface ProposalCardProps {
  vm: ProposalViewModel;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  /** True while THIS card's approve/reject mutation is in flight. */
  isBusy?: boolean;
}

export function ProposalCard({ vm, onApprove, onReject, isBusy = false }: ProposalCardProps) {
  const t = useTranslations('inbox');

  return (
    <div
      data-testid="proposal-card"
      className="flex items-start gap-3.5"
      style={{ padding: '16px 20px' }}
    >
      {/* Calm rounded icon-tile (40px) leading the row — color for attention. */}
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center justify-center rounded-xl"
        style={{
          width: 40,
          height: 40,
          background: 'color-mix(in oklab, var(--primary) 12%, transparent)',
          color: 'var(--primary)',
        }}
      >
        <Sparkles className="h-[18px] w-[18px]" />
      </span>

      <div className="min-w-0 flex-1">
        {/* The user-framed "why" — largest type, the eye lands here. */}
        <div className="text-[15px] font-medium" style={{ color: 'var(--text)' }}>
          {vm.whyTitle}
        </div>
        <div
          className="mt-1 flex flex-wrap items-center gap-2 text-[13px]"
          style={{ color: 'var(--text-muted)' }}
        >
          <span>{vm.scopeLabel}</span>
          <span aria-hidden="true">·</span>
          <span>{vm.createdRelative}</span>
        </div>
      </div>

      {/* The user's two verbs. APPROVE = the teal primary one-click; REJECT =
       *  a quiet dismiss. Both disabled while this card's mutation is in flight. */}
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => onApprove(vm.id)}
          disabled={isBusy}
          aria-busy={isBusy}
          data-testid="proposal-approve"
        >
          {vm.approveLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onReject(vm.id)}
          disabled={isBusy}
          data-testid="proposal-reject"
        >
          {t('reject')}
        </Button>
      </div>
    </div>
  );
}
