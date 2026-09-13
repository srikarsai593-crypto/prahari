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
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast-enter px-4 py-3 rounded-lg shadow-lg text-white font-medium backdrop-blur-md border ${
              toast.type === 'alert' ? 'bg-red-500/80 border-red-500' :
              toast.type === 'warning' ? 'bg-amber-500/80 border-amber-500' :
              toast.type === 'success' ? 'bg-green-500/80 border-green-500' :
              'bg-blue-500/80 border-blue-500'
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
