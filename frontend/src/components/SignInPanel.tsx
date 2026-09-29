'use client';

import { useEffect, useState } from 'react';
import { Eye, KeyRound, ShieldAlert } from 'lucide-react';
import { useSession } from './SessionProvider';

/**
 * The sign-in form itself, with no opinion about where it sits.
 *
 * It used to exist only inside `LoginGate`, which renders it as a full-screen
 * wall and only when the station refuses anonymous reads. On a station with
 * `PRAHARI_PUBLIC_READS` set there is no wall — the console opens straight
 * onto the dashboard, which is the right first impression — but there was
 * then no way to sign in at all, so every write control on an otherwise
 * working console failed and nothing on the page explained why or offered a
 * way out.
 *
 * So the form is its own component and the wall is one of two callers. The
 * other is the dialog behind "Sign in" in the navigation band.
 */
export function SignInPanel({ onSignedIn, compact = false }: {
  /** Called after a successful sign-in, so a dialog can close itself. */
  onSignedIn?: () => void;
  /** Drop the explanatory paragraph where the surrounding UI already says it. */
  compact?: boolean;
}) {
  const { authenticated, state, signIn, enterAsObserver } = useSession();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [observing, setObserving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (authenticated) { setKey(''); setError(null); } }, [authenticated]);

  const signInWith = async (candidate: string) => {
    setBusy(true);
    setError(null);
    try {
      await signIn(candidate);
      onSignedIn?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!key.trim()) return setError('Enter the station commander key.');
    await signInWith(key.trim());
  };

  const observe = async () => {
    setObserving(true);
    setError(null);
    try {
      await enterAsObserver();
      onSignedIn?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open a read-only view.');
    } finally {
      setObserving(false);
    }
  };

  return (
    <form onSubmit={submit}
          className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
      <h2 className="text-base font-bold text-white mb-1">Station sign-in</h2>
      {!compact && (
        <p className="text-13 text-slate-300 leading-relaxed mb-5">
          This console carries live positions for everyone in the field, so it is not
          served anonymously. Sign in with the station commander key.
        </p>
      )}
      {compact && (
        <p className="text-13 text-slate-300 leading-relaxed mb-5">
          You are reading this station without a session. Sign in to change the record.
        </p>
      )}

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
          // The wall is the whole page and the field is why anyone is
          // looking at it. Inside the dialog the focus trap places focus
          // instead, and a second claim on it would fight that.
          autoFocus={!compact}
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

      {/* Someone handed the link is otherwise met by a key prompt and a
          console correctly refusing to show them anything. This is the
          middle ground, and it is a real session rather than an open
          door: read everything, change nothing. */}
      {state?.observer_enabled && (
        <div className="mt-5 pt-4 border-t border-white/10">
          <button type="button" disabled={observing} onClick={() => void observe()}
                  className="btn-secondary w-full !py-2.5 text-13">
            <Eye size={14} aria-hidden="true" />
            {observing ? 'Opening…' : 'Enter as observer'}
          </button>
          <p className="mt-2 text-2xs text-slate-400 leading-relaxed text-center">
            Read-only. You will see every module and be able to change nothing.
          </p>
        </div>
      )}

      {/*
        A station running on the published demo key has no secret to
        protect — the key is printed in the README and this screen has
        just displayed it. Making somebody copy it into the field above
        and then press Sign in is two steps of ceremony guarding nothing,
        and it is the first thing anyone handed the link meets.

        Still the real sign-in: the same POST, the same session cookie,
        the same audit line. The button skips the typing, not the
        exchange. It says which key it is using, so nobody is signed in
        by a control that did not tell them what it did.
      */}
      {state?.demo_key_enabled && state.demo_key && (
        <div className="mt-5 pt-4 border-t border-white/10">
          <button type="button" disabled={busy}
                  onClick={() => void signInWith(state.demo_key ?? '')}
                  className="btn-secondary w-full !py-2.5 text-13">
            <KeyRound size={14} aria-hidden="true" />
            Sign in with the public demo key
          </button>
          <p className="mt-2 text-2xs text-slate-400 leading-relaxed text-center">
            This station runs on{' '}
            <span className="font-mono text-arctic-300">{state.demo_key}</span>, which is
            published. Full access — every module, and changes are saved.
          </p>
        </div>
      )}
    </form>
  );
}
