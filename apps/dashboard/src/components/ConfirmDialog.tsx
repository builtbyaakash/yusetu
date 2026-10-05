import { Modal } from "./Modal";

export type ConfirmIntent = {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
};

type ConfirmDialogProps = {
  intent: ConfirmIntent | null;
  onDismiss: () => void;
  busy?: boolean;
};

export function ConfirmDialog({
  intent,
  onDismiss,
  busy = false,
}: ConfirmDialogProps) {
  if (!intent) return null;

  return (
    <Modal title={intent.title} onClose={onDismiss}>
      <p className="confirm-message">{intent.message}</p>
      <div className="form-actions row-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onDismiss}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className={intent.danger ? "btn btn-danger" : "btn btn-primary"}
          disabled={busy}
          onClick={() => intent.onConfirm()}
        >
          {busy ? "Working…" : (intent.confirmLabel ?? "Confirm")}
        </button>
      </div>
    </Modal>
  );
}
