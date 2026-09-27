'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Loader2, ShieldAlert } from 'lucide-react';
import { useSession } from './SessionProvider';
import { PrahariLogo } from './PrahariLogo';

/**
 * Sign-in wall for the console.
 *
 * The roster carries live positions for everyone on the ice, so this is not a
 * formality over a public page — the data behind it is the reason it is here.
 */
export function LoginGate({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, state, signIn } = useSession();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reads may be open on a kiosk deployment; there is nothing to gate then.
  const gated = !authenticated && !(state?.public_reads ?? false);

  useEffect(() => { if (authenticated) { setKey(''); setError(null); } }, [authenticated]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!key.trim()) return setError('Enter the station commander key.');
    setBusy(true);
    setError(null);
    try {
      await signIn(key.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

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

        <form onSubmit={submit}
              className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
          <h2 className="text-base font-bold text-white mb-1">Station sign-in</h2>
          <p className="text-13 text-slate-300 leading-relaxed mb-5">
            This console carries live positions for everyone in the field, so it is not
            served anonymously. Sign in with the station commander key.
          </p>

          <label htmlFor="commander-key"
                 className="block font-mono text-2xs uppercase tracking-caps text-slate-400 mb-1.5">
            Commander key
          </label>
          <div className="relative">
            <KeyRound size={15} aria-hidden="true"
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400
                                 pointer-events-none" />
            <input
              id="commander-key"
              type="password"
              value={key}
              autoFocus
              autoComplete="current-password"
              onChange={(event) => { setKey(event.target.value); setError(null); }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'sign-in-error' : undefined}
              className="w-full !bg-white/5 !border-white/20 !text-white !pl-10 !py-2.5
                         placeholder:!text-slate-500 font-mono text-13"
              placeholder="••••••••••••"
            />
          </div>

          {error && (
            <p id="sign-in-error" role="alert"
               className="mt-3 flex items-start gap-2 text-2xs text-rose-300">
              <ShieldAlert size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
              {error}
            </p>
          )}

          <button type="submit" disabled={busy}
                  className="btn-primary w-full mt-5 !py-2.5 tracking-caps uppercase text-13">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          {state?.demo_key_enabled && state.demo_key && (
            <div className="mt-5 pt-4 border-t border-white/10">
              <p className="text-2xs text-slate-400 leading-relaxed">
                This station is running on the public demo key. Use{' '}
                <button type="button"
                        onClick={() => setKey(state.demo_key ?? '')}
                        className="font-mono text-arctic-300 hover:text-white underline
                                   underline-offset-2">
                  {state.demo_key}
                </button>{' '}
                to sign in.
              </p>
            </div>
          )}
        </form>

        <p className="mt-4 text-center text-2xs text-slate-500">
          Offline-first station console · keeps working when the link drops
        </p>
      </div>
    </div>
  );
}
