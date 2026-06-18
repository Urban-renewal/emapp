/**
 * FINDING-1 (docs/E1-FLOW-TEST.md) — the styled confirm dialog that replaces
 * every native `window.confirm()`. This spec pins the two halves of the
 * component's contract:
 *
 *  A) The promise semantics (the part a caller relies on):
 *       confirm() → confirm-button  resolves TRUE
 *       confirm() → cancel/ESC/overlay resolves FALSE
 *     These all route through `ConfirmController.resolve(boolean)` — the
 *     headless seam extracted specifically so the resolve logic is testable
 *     in the repo's node-env (no DOM / testing-library; see
 *     `_components/sidebar.spec.ts` for the same constraint). The dialog's
 *     confirm button calls resolve(true); cancel button, ESC handler and the
 *     backdrop click all call resolve(false) — so exercising the controller
 *     IS exercising those three cancel paths.
 *
 *  B) The a11y contract of the rendered modal, asserted on the real
 *     `renderToStaticMarkup` output: role="alertdialog", aria-modal, the
 *     aria-labelledby/aria-describedby wiring, and the destructive-variant
 *     danger styling (the `.btn-danger` token class, never an inline hex).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// next-intl is the only external dep the dialog reaches for (the generic
// title/confirm/cancel fallbacks). Mirror the real he.json `confirm` keys.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) =>
    ({ title: 'אישור פעולה', confirm: 'אישור', cancel: 'ביטול' })[key] ?? `MISSING:${key}`,
}));

import { ConfirmDialog, createConfirmController, type ConfirmOptions } from './confirm-dialog';

describe('createConfirmController — promise resolution (A)', () => {
  it('1) confirm-button path: resolve(true) settles the promise TRUE', async () => {
    const onChange = vi.fn();
    const ctrl = createConfirmController(onChange);
    const p = ctrl.open({ message: 'ארכוב?' });
    // open() flips visible state → React would re-render.
    expect(ctrl.options).not.toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    ctrl.resolve(true); // what the confirm <Button> onClick does
    await expect(p).resolves.toBe(true);
    // resolving closes the dialog (options cleared) and notifies React again.
    expect(ctrl.options).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('2) cancel / ESC / overlay path: resolve(false) settles the promise FALSE', async () => {
    const ctrl = createConfirmController(() => {});
    const p = ctrl.open({ message: 'בטל בקשה?' });
    // The cancel button, the ESC keydown handler and the backdrop onClick ALL
    // call onCancel → controller.resolve(false). One assertion covers the three.
    ctrl.resolve(false);
    await expect(p).resolves.toBe(false);
    expect(ctrl.options).toBeNull();
  });

  it('3) resolve() when already closed is a no-op (idempotent)', async () => {
    const ctrl = createConfirmController(() => {});
    const p = ctrl.open({ message: 'x' });
    ctrl.resolve(true);
    await expect(p).resolves.toBe(true);
    // A stray second resolve (e.g. ESC firing after the button) must not throw.
    expect(() => ctrl.resolve(false)).not.toThrow();
  });

  it('4) opening a second dialog while one is pending resolves the first FALSE', async () => {
    const ctrl = createConfirmController(() => {});
    const first = ctrl.open({ message: 'first' });
    const second = ctrl.open({ message: 'second' });
    // The abandoned first prompt resolves false; the new one is live.
    await expect(first).resolves.toBe(false);
    expect(ctrl.options?.message).toBe('second');
    ctrl.resolve(true);
    await expect(second).resolves.toBe(true);
  });
});

/** Render the dialog with the given options to static HTML. */
function renderDialog(options: ConfirmOptions | null): string {
  return renderToStaticMarkup(
    createElement(ConfirmDialog, { options, onConfirm: () => {}, onCancel: () => {} }),
  );
}

describe('ConfirmDialog — render + a11y contract (B)', () => {
  it('5) renders NOTHING while closed (options null)', () => {
    expect(renderDialog(null)).toBe('');
  });

  it('6) open: role="alertdialog" + aria-modal + labelled/described wiring', () => {
    const html = renderDialog({ message: 'האם לארכב את בעל הדירה?' });
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="confirm-dialog-title"');
    expect(html).toContain('aria-describedby="confirm-dialog-message"');
    // The referenced ids actually exist on the title + message nodes.
    expect(html).toContain('id="confirm-dialog-title"');
    expect(html).toContain('id="confirm-dialog-message"');
    // The caller's message is the described-by body text.
    expect(html).toContain('האם לארכב את בעל הדירה?');
  });

  it('7) generic i18n fallbacks fill title + both button labels', () => {
    const html = renderDialog({ message: 'q' });
    expect(html).toContain('אישור פעולה'); // confirm.title
    expect(html).toContain('אישור'); // confirm.confirm
    expect(html).toContain('ביטול'); // confirm.cancel
  });

  it('8) caller-supplied title + labels override the fallbacks', () => {
    const html = renderDialog({
      message: 'q',
      title: 'כותרת מותאמת',
      confirmLabel: 'מחק לצמיתות',
      cancelLabel: 'חזרה',
    });
    expect(html).toContain('כותרת מותאמת');
    expect(html).toContain('מחק לצמיתות');
    expect(html).toContain('חזרה');
  });

  it('9) destructive variant uses the .btn-danger token class — no inline hex', () => {
    const html = renderDialog({ message: 'q', destructive: true });
    expect(html).toContain('btn-danger');
    // The danger color must come from the token class, never an inline literal
    // (keeps the inline-color ratchet green).
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    // Non-destructive confirm carries no danger class.
    expect(renderDialog({ message: 'q' })).not.toContain('btn-danger');
  });
});
