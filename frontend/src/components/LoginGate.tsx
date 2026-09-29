'use client';

import { Loader2 } from 'lucide-react';
import { useSession } from './SessionProvider';
import { PrahariLogo } from './PrahariLogo';
import { SignInPanel } from './SignInPanel';

/**
 * Sign-in wall for the console.
 *
 * The roster carries live positions for everyone on the ice, so this is not a
 * formality over a public page — the data behind it is the reason it is here.
 *
 * On a station configured for open reads there is no wall, and the console
 * opens straight onto the dashboard. Signing in is then still possible, from
 * the navigation band; see `SignInPanel`, which both surfaces share.
 */
export function LoginGate({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, state } = useSession();

  // Reads may be open on a kiosk deployment; there is nothing to gate then.
  const gated = !authenticated && !(state?.public_reads ?? false);

  // Hold the first paint until the session probe answers, or an operator who
  // is already signed in sees the login screen flash before their console.
  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-arctic-950">
        <Loader2 size={20} className="animate-spin text-arctic-400" aria-hidden="true" />
        <span className="sr-only">Checking station credentials…</span>
      </div>
    );
  }

  if (!gated) return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-arctic-950 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-6">
          <PrahariLogo size={44} className="text-arctic-400" />
          <div>
            <p className="font-mono text-2xs uppercase tracking-caps text-arctic-400">
              NCPOR · Ministry of Earth Sciences
            </p>
            <h1 className="text-xl font-extrabold text-white tracking-tight">
              PRAHARI Station Console
            </h1>
          </div>
        </div>

        <SignInPanel />

        <p className="mt-4 text-center text-2xs text-slate-500">
          Offline-first station console · keeps working when the link drops
        </p>
      </div>
    </div>
  );
}
