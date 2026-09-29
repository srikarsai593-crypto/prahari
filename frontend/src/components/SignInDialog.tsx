'use client';

import { X } from 'lucide-react';
import { useDialogFocus } from '@/lib/useDialogFocus';
import { SignInPanel } from './SignInPanel';

/**
 * Signing in from inside a console that is already showing you the station.
 *
 * The wall in `LoginGate` only appears where the station refuses anonymous
 * reads. Where it does not — a kiosk, or a deliberately public demo — the
 * console opens on the dashboard with no session, every write control fails,
 * and there is nothing to click to fix that. This is that missing control.
 */
export function SignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useDialogFocus<HTMLDivElement>(open, onClose);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Station sign-in"
      className="fixed inset-0 z-[80] bg-arctic-950/60 backdrop-blur-sm flex items-start
                 justify-center px-4 py-10 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md relative">
        {/* After the panel in the DOM, though absolutely positioned above
            it: the focus trap moves focus to the first focusable child, and
            somebody who opened a sign-in dialog wants the key field, not the
            control that throws it away. */}
        <SignInPanel compact onSignedIn={onClose} />
        <button
          type="button"
          data-compact
          onClick={onClose}
          aria-label="Close sign-in"
          className="absolute -top-1 right-1 z-10 p-1.5 rounded text-slate-300
                     hover:text-white hover:bg-white/10 transition-colors"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
