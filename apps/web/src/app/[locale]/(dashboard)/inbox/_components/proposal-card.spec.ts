/**
 * ProposalCard render — Autonomous Master Plan, Phase 1 (the Approval Inbox).
 *
 * The repo's vitest env is `node` (no DOM / testing-library), so we render the
 * REAL card via `react-dom/server` `renderToStaticMarkup` and assert on the HTML
 * string — the same technique as `sidebar.spec.ts`.
 *
 * Pins:
 *   - APPROVE + REJECT buttons both render (the user's two one-click verbs),
 *     carrying the test ids the inbox + G-QA walk target.
 *   - The user-framed "why" + the user's approve verb render verbatim (VOICE
 *     LAW — the copy is the user's decision, not system-hero output).
 *   - NO PII in the markup: a VM is, by construction, PII-free (the adapter
 *     guarantees it), but we assert the rendered card carries none of the
 *     PII-looking tokens.
 *   - Buttons disable while busy (so a double-click can't double-apply).
 *
 * Click WIRING (onApprove/onReject fire with the row id) is exercised by the
 * `inbox-list.client` integration at the hook layer (`use-proposals.spec.ts`);
 * here we pin the rendered affordance + copy + a11y.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ProposalViewModel } from '@/models/proposal.vm';

import { ProposalCard } from './proposal-card';

// next-intl — only `inbox.reject` is read by the card; map it to the real label.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => (key === 'reject' ? 'דחה' : `MISSING:${key}`),
}));

const VM: ProposalViewModel = {
  id: 'p-1',
  kind: 'signature_request.reissue',
  whyTitle: 'בקשת חתימה שפגה — מוצע להנפיק מחדש',
  approveLabel: 'אשר הנפקה מחדש',
  scopeLabel: 'בקשת חתימה',
  createdRelative: 'לפני שעה',
  createdAtIso: '2026-06-22T08:00:00.000Z',
};

function render(props: Partial<Parameters<typeof ProposalCard>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ProposalCard, {
      vm: VM,
      onApprove: () => {},
      onReject: () => {},
      ...props,
    }),
  );
}

describe('ProposalCard', () => {
  it('1) renders the user-framed why + the user approve verb', () => {
    const html = render();
    expect(html).toContain('בקשת חתימה שפגה — מוצע להנפיק מחדש');
    expect(html).toContain('אשר הנפקה מחדש');
    expect(html).toContain('בקשת חתימה');
    expect(html).toContain('לפני שעה');
  });

  it('2) renders BOTH one-click verbs (approve + reject)', () => {
    const html = render();
    expect(html).toContain('data-testid="proposal-approve"');
    expect(html).toContain('data-testid="proposal-reject"');
    expect(html).toContain('דחה');
  });

  it('3) VOICE LAW — no first-person system-hero verb in the rendered card', () => {
    const html = render();
    for (const banned of ['טיפלתי', 'תזמנתי', 'הנפקתי', 'שלחתי']) {
      expect(html).not.toContain(banned);
    }
  });

  it('4) disables both buttons while busy (no double-apply)', () => {
    const html = render({ isBusy: true });
    // Both buttons carry the disabled attribute in the busy state.
    const disabledCount = (html.match(/disabled/g) ?? []).length;
    expect(disabledCount).toBeGreaterThanOrEqual(2);
    expect(html).toContain('aria-busy="true"');
  });

  it('5) renders no PII (the VM is PII-free; the card surfaces none)', () => {
    const html = render();
    expect(html).not.toContain('040000018');
    expect(html).not.toContain('0501234567');
    // The card never renders the raw machine kind to the user.
    expect(html).not.toContain('signature_request.reissue');
  });
});
