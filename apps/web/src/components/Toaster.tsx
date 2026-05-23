import { useToastStore, type Toast } from "@/lib/toast";
import * as I from "@/components/icons";

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const icon = {
    success: <I.Check size={14} />,
    error: <I.Close size={14} />,
    info: <I.Info size={14} />,
    warning: <I.Warn size={14} />,
  }[toast.kind];

  return (
    <div className={`toast toast--${toast.kind}`} role="status">
      <div className="toast__icon">{icon}</div>
      <div className="toast__body">
        <div className="toast__message">{toast.message}</div>
        {toast.description && (
          <div className="toast__description">{toast.description}</div>
        )}
      </div>
      <button
        type="button"
        className="toast__close"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <I.Close size={12} />
      </button>
    </div>
  );
}
