/**
 * E2 Wave-0 M0+G6 — the app-root action-toast / aria-live region.
 *
 * Mirrors `confirm-dialog.spec.ts`: the queue / auto-dismiss / undo / concurrent
 * settle logic lives in the headless `createToastController` (no React, no DOM)
 * so it is unit-testable in the repo's node-env; the a11y contract is asserted
 * on the real `renderToStaticMarkup` output of `<ToastRegion>`.
 *
 *  A) Controller semantics — open · auto-dismiss · undo fires · concurrent
 *     settle · pause/resume (pause-on-hover) · idempotent dismiss.
 *  B) Render + a11y — role="status" aria-live="polite" (+ assertive sibling),
 *     the undo button, and no inline color literal (ratchet stays green).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// next-intl — the region only reaches for the dismiss aria-label + (in the
// tests below we pass undo labels explicitly, so only `dismiss` is read).
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => ({ dismiss: 'סגירה', undo: 'ביטול' })[key] ?? key,
}));

import {
  createToastController,
  ToastRegion,
  DEFAULT_TOAST_TIMEOUT_MS,
  type ToastController,
} from './action-toast';

describe('createToastController — queue + auto-dismiss + undo (A)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('1) show() queues a toast and notifies React', () => {
    const onChange = vi.fn();
    const ctrl = createToastController(onChange);
    const id = ctrl.show({ message: 'נשמר' });
    expect(typeof id).toBe('number');
    expect(ctrl.toasts).toHaveLength(1);
    expect(ctrl.toasts[0]!.message).toBe('נשמר');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('2) auto-dismiss: the toast clears after its timeout', () => {
    const onChange = vi.fn();
    const ctrl = createToastController(onChange);
    ctrl.show({ message: 'נשמר' });
    expect(ctrl.toasts).toHaveLength(1);
    vi.advanceTimersByTime(DEFAULT_TOAST_TIMEOUT_MS);
    expect(ctrl.toasts).toHaveLength(0);
    // onChange fired on show AND on the auto-dismiss.
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('3) timeoutMs:0 is sticky — never auto-dismisses', () => {
    const ctrl = createToastController(() => {});
    ctrl.show({ message: 'נשמר', timeoutMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(ctrl.toasts).toHaveLength(1);
  });

  it('4) undo fires the caller onUndo and dismisses immediately', async () => {
    const ctrl = createToastController(() => {});
    const onUndo = vi.fn();
    const id = ctrl.show({ message: 'הוסר', undo: { label: 'בטל', onUndo } });
    // The view calls onUndo then dismiss; here we assert the dismiss handle
    // works and the caller's inverse runs.
    expect(ctrl.toasts[0]!.undo?.onUndo).toBe(onUndo);
    ctrl.toasts[0]!.undo!.onUndo();
    ctrl.dismiss(id);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(ctrl.toasts).toHaveLength(0);
  });

  it('5) concurrent settle: two toasts queue independently and each expires on its own timer', () => {
    const ctrl = createToastController(() => {});
    ctrl.show({ message: 'first', timeoutMs: 1000 });
    ctrl.show({ message: 'second', timeoutMs: 3000 });
    expect(ctrl.toasts.map((t) => t.message)).toEqual(['first', 'second']);
    // First expires; second still live (no clobber).
    vi.advanceTimersByTime(1000);
    expect(ctrl.toasts.map((t) => t.message)).toEqual(['second']);
    vi.advanceTimersByTime(2000);
    expect(ctrl.toasts).toHaveLength(0);
  });

  it('6) pause() holds the timer (pause-on-hover); resume() restarts it', () => {
    const ctrl = createToastController(() => {});
    const id = ctrl.show({ message: 'נשמר', timeoutMs: 1000 });
    ctrl.pause(id);
    // While paused the toast does not expire, however long we wait.
    vi.advanceTimersByTime(5000);
    expect(ctrl.toasts).toHaveLength(1);
    // Resume restarts the full window.
    ctrl.resume(id);
    vi.advanceTimersByTime(999);
    expect(ctrl.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ctrl.toasts).toHaveLength(0);
  });

  it('7) dismiss() is idempotent and only notifies on a real change', () => {
    const onChange = vi.fn();
    const ctrl = createToastController(onChange);
    const id = ctrl.show({ message: 'x' });
    onChange.mockClear();
    ctrl.dismiss(id);
    expect(onChange).toHaveBeenCalledTimes(1);
    // A second dismiss of the same id is a no-op (no extra notify, no throw).
    expect(() => ctrl.dismiss(id)).not.toThrow();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('8) ids are monotonic and unique across shows', () => {
    const ctrl = createToastController(() => {});
    const a = ctrl.show({ message: 'a' });
    const b = ctrl.show({ message: 'b' });
    expect(b).toBeGreaterThan(a);
  });
});

/** Render the region for the given controller to static HTML. */
function render(controller: ToastController): string {
  return renderToStaticMarkup(createElement(ToastRegion, { controller }));
}

describe('ToastRegion — render + a11y live-region contract (B)', () => {
  it('9) always renders BOTH live regions: status(polite) + alert(assertive)', () => {
    const ctrl = createToastController(() => {});
    const html = render(ctrl);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
  });

  it('10) a polite toast renders its message in the status region', () => {
    const ctrl = createToastController(() => {});
    ctrl.show({ message: 'הנתונים נשמרו' });
    const html = render(ctrl);
    expect(html).toContain('הנתונים נשמרו');
    expect(html).toContain('data-testid="toast"');
  });

  it('11) an undo toast renders the undo button with the caller label', () => {
    const ctrl = createToastController(() => {});
    ctrl.show({ message: 'הוסר', undo: { label: 'שחזר', onUndo: () => {} } });
    const html = render(ctrl);
    expect(html).toContain('data-testid="toast-undo"');
    expect(html).toContain('שחזר');
  });

  it('12) assertive variant routes to the alert region, not status', () => {
    const ctrl = createToastController(() => {});
    ctrl.show({ message: 'שגיאה', variant: 'assertive' });
    const html = render(ctrl);
    // The message sits AFTER the role="alert" marker in source order.
    const alertIdx = html.indexOf('role="alert"');
    const msgIdx = html.indexOf('שגיאה');
    expect(alertIdx).toBeGreaterThanOrEqual(0);
    expect(msgIdx).toBeGreaterThan(alertIdx);
  });

  it('13) no inline color literal in the rendered markup (ratchet posture)', () => {
    const ctrl = createToastController(() => {});
    ctrl.show({ message: 'נשמר', undo: { label: 'בטל', onUndo: () => {} } });
    const html = render(ctrl);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(html).not.toMatch(/rgba?\(/i);
    expect(html).not.toMatch(/hsla?\(/i);
  });
});
