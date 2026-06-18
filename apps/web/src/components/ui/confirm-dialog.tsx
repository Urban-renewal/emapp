'use client';

/**
 * Styled confirm dialog — the ONE in-app replacement for `window.confirm()`.
 *
 * FINDING-1 (docs/E1-FLOW-TEST.md): every destructive action used the native
 * browser `window.confirm()` — unstyled, off-brand, unthemeable, jarring for
 * the non-technical user (against docs/DESIGN-NORTH-STAR.md), and it blocks
 * the JS thread. This replaces all ~18 call-sites with one styled,
 * token-themed, RTL, a11y-correct modal.
 *
 * Usage (mirrors `useStepUpUnlock` — the repo's first true modal):
 *
 *   const { confirm, dialog } = useConfirm();
 *   ...
 *   async function onArchive() {
 *     if (!(await confirm({ message: t('archiveConfirm'), destructive: true }))) return;
 *     await archive.mutateAsync(id);
 *   }
 *   ...
 *   return <>... {dialog}</>;
 *
 * `confirm(opts)` returns a Promise<boolean> that resolves `true` when the
 * user presses the confirm button and `false` on cancel / ESC / overlay click.
 * Render `dialog` once in the caller's tree (it is `null` while closed).
 *
 * Mirrors `StepUpDialog` (src/components/step-up-unlock.tsx) for:
 *   - the fixed-overlay modal mount (`fixed inset-0 z-50` + click-dismiss
 *     backdrop) — it is a real app modal, NOT a widget;
 *   - the `Button` primitive + inline-status palette (var(--danger-*));
 *   - a hook that owns the open state and a settle() that resolves all
 *     waiters, so concurrent callers share one dialog.
 *
 * Adds (beyond StepUpDialog) the alertdialog a11y contract:
 *   - role="alertdialog" + aria-modal + aria-labelledby/aria-describedby;
 *   - ESC closes (resolves false);
 *   - focus moves to the SAFE (cancel) button on open;
 *   - a focus trap that keeps Tab within the dialog.
 */
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

/** Options for a single confirm() call. All copy is caller-supplied (i18n). */
export interface ConfirmOptions {
  /** Body text — the question the user answers. Required. */
  message: string;
  /** Optional heading above the message. Falls back to a generic i18n title. */
  title?: string;
  /** Confirm-button label. Falls back to a generic i18n label. */
  confirmLabel?: string;
  /** Cancel-button label. Falls back to a generic i18n label. */
  cancelLabel?: string;
  /**
   * Danger styling for the confirm button (archive / cancel / delete /
   * suspend). Uses the danger token, not the primary brand color.
   */
  destructive?: boolean;
}

export interface UseConfirm {
  /** Open the dialog; resolves true on confirm, false on cancel/ESC/overlay. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** Render once in the caller's tree (null while closed). */
  dialog: ReactNode;
}

/**
 * Headless controller — owns the resolve-promise + the open options, with NO
 * React dependency so the resolve semantics (confirm→true, cancel→false) are
 * unit-testable in the repo's node-env without a DOM. The hook is a thin
 * React binding over this.
 */
export interface ConfirmController {
  /** Current options when open, else null. */
  readonly options: ConfirmOptions | null;
  /** Open with `opts`; the returned promise settles on resolve(). */
  open: (opts: ConfirmOptions) => Promise<boolean>;
  /** Settle the pending waiter and close. Idempotent if already closed. */
  resolve: (value: boolean) => void;
}

export function createConfirmController(onChange: () => void): ConfirmController {
  let options: ConfirmOptions | null = null;
  let pending: ((value: boolean) => void) | null = null;

  return {
    get options() {
      return options;
    },
    open(opts: ConfirmOptions): Promise<boolean> {
      // A new open() while one is pending resolves the prior to false (the
      // user effectively abandoned it) — no orphaned promises.
      if (pending) {
        const prev = pending;
        pending = null;
        prev(false);
      }
      options = opts;
      onChange();
      return new Promise<boolean>((res) => {
        pending = res;
      });
    },
    resolve(value: boolean) {
      const p = pending;
      pending = null;
      options = null;
      onChange();
      if (p) p(value);
    },
  };
}

export function useConfirm(): UseConfirm {
  // A version counter is the React-visible state; the controller holds the
  // actual options + pending resolver (kept in a ref so its identity is stable
  // and open()/resolve() never go stale).
  const [, bump] = useState(0);
  const controllerRef = useRef<ConfirmController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createConfirmController(() => bump((v) => v + 1));
  }
  const controller = controllerRef.current;

  const confirm = useCallback((opts: ConfirmOptions) => controller.open(opts), [controller]);

  const onCancel = useCallback(() => controller.resolve(false), [controller]);
  const onConfirm = useCallback(() => controller.resolve(true), [controller]);

  const dialog = (
    <ConfirmDialog options={controller.options} onConfirm={onConfirm} onCancel={onCancel} />
  );

  return { confirm, dialog };
}

export function ConfirmDialog({
  options,
  onConfirm,
  onCancel,
}: {
  options: ConfirmOptions | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('confirm');
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = options !== null;

  // Focus the SAFE (cancel) button when the dialog opens.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  // ESC closes (resolves false); Tab is trapped within the dialog.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!options) return null;

  const title = options.title ?? t('title');
  const confirmLabel = options.confirmLabel ?? t('confirm');
  const cancelLabel = options.cancelLabel ?? t('cancel');

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      data-testid="confirm-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop — click dismisses (same semantics as Cancel). */}
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" onClick={onCancel} />
      <div
        ref={dialogRef}
        className="relative z-10 w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 text-start shadow-lg"
      >
        <h2 id="confirm-dialog-title" className="text-lg font-semibold">
          {title}
        </h2>
        <p id="confirm-dialog-message" className="text-sm text-muted-foreground">
          {options.message}
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
            // Destructive actions use the canonical `.btn-danger` token class
            // (background var(--danger-600) + on-danger text) — not the brand
            // primary. No inline color literal → the ratchet stays green.
            className={options.destructive ? 'btn-danger' : undefined}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
