/** Short-lived messages in the corner. Errors stay until dismissed. */
import { useCallback, useState } from 'preact/hooks';
import { IconClear } from './icons';

export type ToastTone = 'info' | 'ok' | 'warn' | 'error';

export interface Toast {
  readonly id: number;
  readonly tone: ToastTone;
  readonly text: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

let nextId = 1;

export interface ToastApi {
  readonly toasts: readonly Toast[];
  push: (tone: ToastTone, text: string, action?: Toast['action']) => void;
  dismiss: (id: number) => void;
}

export function useToasts(): ToastApi {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (tone: ToastTone, text: string, action?: Toast['action']) => {
      const id = nextId++;
      setToasts((all) => [...all.filter((t) => t.text !== text).slice(-3), { id, tone, text, action }]);
      if (tone !== 'error' && !action) setTimeout(() => dismiss(id), tone === 'warn' ? 9000 : 5000);
    },
    [dismiss],
  );
  return { toasts, push, dismiss };
}

export function Toasts({ api }: { api: ToastApi }) {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {api.toasts.map((t) => (
        <div key={t.id} class={`toast ${t.tone}`}>
          <p>{t.text}</p>
          {t.action && (
            <button
              type="button"
              class="btn small"
              onClick={() => {
                t.action?.run();
                api.dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" class="icon-btn" style={{ width: '24px', height: '24px' }} title="Dismiss" onClick={() => api.dismiss(t.id)}>
            <IconClear size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
