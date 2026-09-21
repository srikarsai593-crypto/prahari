'use client';
import { createContext, useContext, useState, ReactNode } from 'react';

type ToastType = 'alert' | 'warning' | 'success' | 'info';

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  addToast: (message: string, type: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
};

const toastStyles: Record<ToastType, string> = {
  alert:   'border-rose-200   bg-white text-rose-900',
  warning: 'border-amber-200  bg-white text-amber-900',
  success: 'border-emerald-200 bg-white text-emerald-900',
  info:    'border-arctic-200  bg-white text-arctic-900',
};

const toastIcon: Record<ToastType, string> = {
  alert:   '⚠️',
  warning: '🔔',
  success: '✅',
  info:    'ℹ️',
};

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = (message: string, type: ToastType) => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  };

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast-enter pointer-events-auto px-4 py-3 rounded-xl border shadow-card text-xs font-semibold flex items-center gap-2.5 ${toastStyles[toast.type]}`}
          >
            <span className="text-sm shrink-0">{toastIcon[toast.type]}</span>
            <span className="flex-1 font-display">{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
