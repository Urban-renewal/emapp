'use client';

/**
 * Action toast + a11y live-region — the ONE app-root feedback primitive.
 *
 * E2 Wave-0 M0+G6 (docs/design-research/v8-final-verification/03-consolidated-
 * master-plan.md §4 row "M0+G6" + §2.3 the two-track action rule).
 *
 * The redesign's core "two-track action rule" (§2.3) says a REVERSIBLE action
 * (the 95%: resend, archive, status, assign, role grant/revoke, share revoke,
 * member remove) must be instant + an undo-toast — NOT a confirm. This is the
 * undo-toast that rule needs, AND the single G6 `aria-live` announcement region
 * the app was missing (see §0 V9 — `components/ui/` had no toast / live-region).
 *
 * ONE region mounted once at the app root (the dashboard layout) is BOTH:
 *   (a) the ActionToast  — auto-dismiss (timeout), pause-on-hover, an optional
 *       `undo` action, and concurrent settle (toasts queue/stack cleanly); AND
 *   (b) the a11y announcement region — `role="status" aria-live="polite"`
 *       (+ an `assertive` sibling for errors).
 *
 * Usage (mirrors `useConfirm()` in confirm-dialog.tsx):
 *
 *   const toast = useToast();
 *   ...
 *   await archive.mutateAsync(id);
 *   toast.show({
 *     message: t('archived'),
 *     undo: { label: t('undo'), onUndo: () => restore.mutateAsync(id) },
 *   });
 *
 * The provider is mounted ONCE (dashboard layout). `useToast()` reads it from
 * context, so any client component in the tree can fire a toast without
 * rendering its own region — unlike `useConfirm()` (per-caller modal).
 *
 * Mirrors confirm-dialog.tsx for:
 *   - the headless `createToastController` seam with NO React dependency, so
 *     the queue / auto-dismiss / undo / resolve semantics are unit-testable in
 *     the repo's node-env without a DOM;
 *   - a thin React binding (the provider) over that controller;
 *   - the a11y contract (role + aria-live + token-only styling, never an
 *     inline color literal — the ratchet stays green).
 */
import { useTranslations } from 'next-intl';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

/** Default auto-dismiss window. Long enough to read + reach the undo button. */
export const DEFAULT_TOAST_TIMEOUT_MS = 6000;

/** The optional undo affordance carried by a reversible action's toast. */
export interface ToastUndo {
  /** Button label (i18n, caller-supplied). */
  label: string;
  /**
   * Fired when the user presses undo. The caller owns the optimistic-undo
   * (e.g. re-run the inverse mutation). May be async; the toast dismisses
   * immediately on press regardless of the promise outcome.
   */
  onUndo: () => void | Promise<void>;
}

/** Options for a single show() call. All copy is caller-supplied (i18n). */
export interface ToastOptions {
  /** Body text — what just happened. Required. */
  message: string;
  /**
   * `polite` (default) routes to the `role="status"` region — non-urgent
   * success/info that should not interrupt the screen reader. `assertive`
   * routes to the `role="alert"` region — an error the user must hear now.
   */
  variant?: 'polite' | 'assertive';
  /** Optional undo affordance (reversible-action toast). */
  undo?: ToastUndo;
  /**
   * Auto-dismiss window in ms. Defaults to `DEFAULT_TOAST_TIMEOUT_MS`.
   * `0` disables auto-dismiss (the toast stays until dismissed/undone).
   */
  timeoutMs?: number;
}

/** A live toast in the queue (options + the controller-assigned id). */
export interface ActiveToast extends ToastOptions {
  /** Monotonic id — stable React key + the dismiss handle. */
  readonly id: number;
}

export interface UseToast {
  /** Queue a toast; returns its id (so the caller can dismiss it early). */
  show: (opts: ToastOptions) => number;
  /** Dismiss a specific toast by id (idempotent). */
  dismiss: (id: number) => void;
}

/**
 * Headless controller — owns the toast queue with NO React dependency, so the
 * queue / dismiss / undo semantics are unit-testable in the repo's node-env
 * without a DOM. The provider is a thin React binding over this.
 *
 * Auto-dismiss timers are scheduled by the controller (it takes the host's
 * setTimeout/clearTimeout so tests can drive fake timers). Pause-on-hover is a
 * VIEW concern (the region clears + reschedules the timer on mouse enter/leave)
 * and lives in the React layer.
 */
export interface ToastController {
  /** Current queue, oldest first. */
  readonly toasts: readonly ActiveToast[];
  /** Queue a toast; returns its id. */
  show: (opts: ToastOptions) => number;
  /** Remove a toast by id (idempotent — no-op if already gone). */
  dismiss: (id: number) => void;
  /** Clear the auto-dismiss timer for `id` (pause-on-hover enter). */
  pause: (id: number) => void;
  /** (Re)start the auto-dismiss timer for `id` (pause-on-hover leave). */
  resume: (id: number) => void;
}

interface TimerHost {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
}

const REAL_TIMERS: TimerHost = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle),
};

export function createToastController(
  onChange: () => void,
  timers: TimerHost = REAL_TIMERS,
): ToastController {
  let nextId = 1;
  let toasts: ActiveToast[] = [];
  const handles = new Map<number, ReturnType<typeof setTimeout>>();

  function clearHandle(id: number): void {
    const h = handles.get(id);
    if (h !== undefined) {
      timers.clear(h);
      handles.delete(id);
    }
  }

  function scheduleDismiss(toast: ActiveToast): void {
    const ms = toast.timeoutMs ?? DEFAULT_TOAST_TIMEOUT_MS;
    // `0` (or negative) ⇒ no auto-dismiss; the toast is sticky until acted on.
    if (ms <= 0) return;
    clearHandle(toast.id);
    handles.set(
      toast.id,
      timers.set(() => dismiss(toast.id), ms),
    );
  }

  function dismiss(id: number): void {
    const before = toasts.length;
    clearHandle(id);
    toasts = toasts.filter((t) => t.id !== id);
    // Idempotent: only notify React if the queue actually changed.
    if (toasts.length !== before) onChange();
  }

  return {
    get toasts() {
      return toasts;
    },
    show(opts: ToastOptions): number {
      const id = nextId++;
      const toast: ActiveToast = { ...opts, id };
      // Concurrent settle: append (oldest-first queue); each toast keeps its
      // own independent auto-dismiss timer, so two toasts fired back-to-back
      // stack and settle cleanly rather than clobbering one another.
      toasts = [...toasts, toast];
      onChange();
      scheduleDismiss(toast);
      return id;
    },
    dismiss,
    pause(id: number) {
      clearHandle(id);
    },
    resume(id: number) {
      const toast = toasts.find((t) => t.id === id);
      if (toast) scheduleDismiss(toast);
    },
  };
}

/* ── React binding ─────────────────────────────────────────────────────── */

const ToastContext = createContext<ToastController | null>(null);

/**
 * Mount ONCE at the app root (the dashboard layout). Owns the controller and
 * renders the live-region. Any descendant calls `useToast()` to fire a toast.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [, bump] = useState(0);
  const controllerRef = useRef<ToastController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createToastController(() => bump((v) => v + 1));
  }
  const controller = controllerRef.current;

  return (
    <ToastContext.Provider value={controller}>
      {children}
      <ToastRegion controller={controller} />
    </ToastContext.Provider>
  );
}

/**
 * The hook callers use. Returns a stable `show` / `dismiss` pair. Throws if
 * used outside `<ToastProvider>` (a wiring bug we want loud in dev/test).
 */
export function useToast(): UseToast {
  const controller = useContext(ToastContext);
  if (controller === null) {
    throw new Error('useToast must be used within <ToastProvider> (dashboard layout)');
  }
  const show = useCallback((opts: ToastOptions) => controller.show(opts), [controller]);
  const dismiss = useCallback((id: number) => controller.dismiss(id), [controller]);
  return { show, dismiss };
}

/** Alias — the redesign refers to the reversible-action toast as the "action toast". */
export const useActionToast = useToast;

/**
 * The rendered live-region. Splits the queue into a `polite` (status) and an
 * `assertive` (alert) region — each its own `aria-live` so a screen reader
 * applies the right urgency. Fixed to the bottom-start corner (RTL-aware via
 * the logical `.toast-region` class), above app chrome.
 */
export function ToastRegion({ controller }: { controller: ToastController }) {
  const polite = controller.toasts.filter((t) => (t.variant ?? 'polite') === 'polite');
  const assertive = controller.toasts.filter((t) => t.variant === 'assertive');

  return (
    <div className="toast-region" data-testid="toast-region">
      <div role="status" aria-live="polite" aria-atomic="false" className="toast-stack">
        {polite.map((t) => (
          <ToastCard key={t.id} toast={t} controller={controller} />
        ))}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="false" className="toast-stack">
        {assertive.map((t) => (
          <ToastCard key={t.id} toast={t} controller={controller} />
        ))}
      </div>
    </div>
  );
}

function ToastCard({ toast, controller }: { toast: ActiveToast; controller: ToastController }) {
  const t = useTranslations('toast');

  // Pause-on-hover / pause-on-focus: hold the auto-dismiss while the pointer
  // (or keyboard focus) is on the toast, so the user can read it / reach undo.
  const onEnter = useCallback(() => controller.pause(toast.id), [controller, toast.id]);
  const onLeave = useCallback(() => controller.resume(toast.id), [controller, toast.id]);

  const onUndo = useCallback(() => {
    // Dismiss immediately, then run the caller's inverse action.
    controller.dismiss(toast.id);
    void toast.undo?.onUndo();
  }, [controller, toast]);

  const onDismiss = useCallback(() => controller.dismiss(toast.id), [controller, toast.id]);

  return (
    <div
      className="toast"
      data-testid="toast"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocusCapture={onEnter}
      onBlurCapture={onLeave}
    >
      <span className="toast-message">{toast.message}</span>
      <div className="toast-actions">
        {toast.undo && (
          <button type="button" className="toast-undo" data-testid="toast-undo" onClick={onUndo}>
            {toast.undo.label}
          </button>
        )}
        <button
          type="button"
          className="toast-dismiss"
          data-testid="toast-dismiss"
          aria-label={t('dismiss')}
          onClick={onDismiss}
        >
          {/* Decorative × — the accessible name comes from aria-label. */}
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}
