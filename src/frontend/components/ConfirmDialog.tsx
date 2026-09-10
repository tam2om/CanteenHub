/**
 * Inline confirmation for a consequential action.
 *
 * Rendered in place rather than as a floating modal: it keeps the row being
 * acted on visible, so the administrator can see exactly which employee they
 * are about to deactivate. The confirm button names the target explicitly,
 * because "Are you sure?" over the wrong row is how the wrong person gets
 * deactivated.
 */

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
  return (
    <div className="confirm" role="alertdialog" aria-label={title}>
      <p className="confirm__title">{title}</p>
      <p className="confirm__detail">{detail}</p>
      <div className="confirm__actions">
        <button type="button" className="button button--ghost" onClick={onCancel} disabled={busy}>
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
