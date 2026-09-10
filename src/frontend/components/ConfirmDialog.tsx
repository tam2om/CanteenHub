/**
 * Inline confirmation for a consequential action.
 *
 * Rendered in place rather than as a floating modal: it keeps the row being
 * acted on visible, so the administrator can see exactly which employee they
 * are about to deactivate. The confirm button names the target explicitly,
 * because "Are you sure?" over the wrong row is how the wrong person gets
 * deactivated.
 *
 * FOCUS BEHAVIOUR. This is an alertdialog guarding a destructive action, so it
 * takes focus when it opens - otherwise a keyboard or screen-reader user is
 * asked a question they were never told about - and Escape cancels it.
 *
 * On close, focus returns to the action group that replaces the dialog rather
 * than to the button that opened it. That is not a compromise, it is the only
 * thing that works here: this dialog is rendered IN PLACE OF the row's actions,
 * so the trigger is unmounted while the dialog is up and a brand new element
 * takes its place on close. Focusing the remembered node would focus a detached
 * one and drop the user at the top of the document. Focusing the replacement
 * keeps the keyboard journey in the same row.
 */

import { useEffect, useRef } from 'react';

interface Props {
  title: string;
  detail: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  detail,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // `onCancel` is read through a ref so the Escape listener does not need to be
  // torn down and rebuilt whenever the parent re-renders with a new closure.
  const cancelHandler = useRef(onCancel);
  cancelHandler.current = onCancel;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Cancel, not confirm: the safe option is the one under the finger when a
    // dialog guarding a destructive action appears.
    cancelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      cancelHandler.current();
    };

    const node = dialogRef.current;
    const container = node?.parentElement ?? null;
    node?.addEventListener('keydown', onKeyDown);

    return () => {
      node?.removeEventListener('keydown', onKeyDown);

      // Reclaim focus when it was ours to begin with. By the time this cleanup
      // runs React has usually already detached the dialog, so the focused
      // element is <body> - focus orphaned by our own unmount. Anything else
      // means something deliberately moved focus elsewhere; leave it alone.
      const active = document.activeElement;
      const focusWasOurs =
        active === null || active === document.body || (node?.contains(active) ?? false);
      if (!focusWasOurs) return;

      // Wait for React to commit the replacement before looking for it.
      queueMicrotask(() => {
        const replacement = container?.querySelector<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])'
        );
        // The remembered node is the fallback: it is still correct on the rare
        // call site whose trigger does survive the dialog.
        (replacement ?? previouslyFocused)?.focus?.();
      });
    };
  }, []);

  return (
    <div
      ref={dialogRef}
      className="confirm"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
    >
      <p className="confirm__title">{title}</p>
      <p className="confirm__detail">{detail}</p>
      <div className="confirm__actions">
        <button
          ref={cancelRef}
          type="button"
          className="button button--ghost"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`button ${destructive ? 'button--danger' : 'button--primary'}`}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </div>
  );
}
