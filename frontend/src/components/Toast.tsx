'use client';
import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react';
import { AlertTriangle, Bell, CheckCircle2, Info, X, type LucideIcon } from 'lucide-react';

type ToastType = 'alert' | 'warning' | 'success' | 'info';

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  addToast: (message: string, type: ToastType) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
};

/**
 * How long each severity stays up.
 *
 * Everything used to vanish after five seconds with no way to keep it, so a
 * stock-shortfall warning or a geofence alert could disappear before the
 * operator finished reading it. Anything the operator may need to act on now
 * stays until it is dismissed; confirmations still clear themselves.
 */
const AUTO_DISMISS_MS: Record<ToastType, number | null> = {
  success: 4_000,
  info: 6_000,
  warning: 12_000,
  alert: null,   // stays until dismissed — these report something that went wrong
};

const MAX_VISIBLE = 5;

// A left accent bar carries the severity; the surface stays white so the text
// is legible under command-room glare.
const toastStyles: Record<ToastType, string> = {
  alert:   'border-emergency-edge border-l-[3px] border-l-emergency bg-white text-arctic-900',
  warning: 'border-alert-edge border-l-[3px] border-l-alert-fill bg-white text-arctic-900',
  success: 'border-nominal-edge border-l-[3px] border-l-nominal-fill bg-white text-arctic-900',
  info:    'border-arctic-200 border-l-[3px] border-l-arctic-600 bg-white text-arctic-900',
};

const toastIcon: Record<ToastType, LucideIcon> = {
  alert: AlertTriangle,
  warning: Bell,
  success: CheckCircle2,
  info: Info,
};

const toastIconColor: Record<ToastType, string> = {
  alert:   'text-emergency',
  warning: 'text-alert',
  success: 'text-nominal',
  info:    'text-arctic-600',
};

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const dismissToast = useCallback((id: string) => {
    const timer = timers.current[id];
    if (timer) { clearTimeout(timer); delete timers.current[id]; }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((message: string, type: ToastType) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setToasts((prev) => {
      // A burst of alerts must not push the page furniture off screen; the
      // oldest drop out once the stack is full.
      const next = [...prev, { id, message, type }];
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });

    const ms = AUTO_DISMISS_MS[type];
    if (ms !== null) {
      timers.current[id] = setTimeout(() => {
        delete timers.current[id];
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, ms);
    }
  }, []);

  // Pending timers must not fire against an unmounted provider.
  useEffect(() => {
    const running = timers.current;
    return () => { Object.values(running).forEach(clearTimeout); };
  }, []);

  const sticky = toasts.filter((t) => AUTO_DISMISS_MS[t.type] === null).length;

  return (
    <ToastContext.Provider value={{ addToast, dismissToast }}>
      {children}
      <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 max-w-sm w-full
                      pointer-events-none"
           role="status" aria-live="polite">
        {toasts.map((toast) => {
          const Icon = toastIcon[toast.type];
          return (
            <div
              key={toast.id}
              className={`toast-enter pointer-events-auto pl-4 pr-2 py-3 rounded-md border
                          shadow-raised text-13 font-medium flex items-start gap-2.5
                          ${toastStyles[toast.type]}`}
            >
              <Icon size={16} aria-hidden="true"
                    className={`shrink-0 mt-0.5 ${toastIconColor[toast.type]}`} />
              <span className="flex-1 min-w-0">{toast.message}</span>
              <button
                type="button"
                data-compact
                onClick={() => dismissToast(toast.id)}
                aria-label="Dismiss notification"
                className="shrink-0 text-frost-muted hover:text-arctic-900 rounded
                           hover:bg-frost-subtle p-1 transition-colors"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}

        {sticky > 1 && (
          <button
            type="button"
            data-compact
            onClick={() => toasts.forEach((t) => dismissToast(t.id))}
            className="pointer-events-auto self-end px-3 py-1.5 rounded-md border
                       border-frost-border bg-white text-2xs font-mono font-bold
                       tracking-caps uppercase text-frost-muted hover:text-arctic-900
                       shadow-card transition-colors"
          >
            Dismiss all
          </button>
        )}
      </div>
    </ToastContext.Provider>
  );
};
