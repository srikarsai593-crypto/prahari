'use client';

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import { api, ApiError, setWriteGuard } from '@/lib/api';
import type { SessionState } from '@/lib/types';

/**
 * Who is signed in to this console.
 *
 * The commander key used to ship in the browser bundle as
 * `NEXT_PUBLIC_COMMANDER_KEY`, so anyone who opened devtools on the hosted
 * console could read the credential that authorises every write. Now the key
 * is exchanged once for an httpOnly cookie that page script cannot read, and
 * the console never holds the credential at all — it only knows whether the
 * browser currently has a valid session.
 */
interface SessionContextValue {
  state: SessionState | null;
  /** False until the first probe returns, so the app does not flash a login
   *  screen at an operator who is already signed in. */
  ready: boolean;
  authenticated: boolean;
  /** Whether this session may change the station's record. An observer is
   *  signed in and cannot write; the console asks this before offering any
   *  control that would be refused. */
  canWrite: boolean;
  isObserver: boolean;
  signIn: (key: string) => Promise<void>;
  enterAsObserver: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue>({
  state: null,
  ready: false,
  authenticated: false,
  canWrite: false,
  isObserver: false,
  signIn: async () => {},
  enterAsObserver: async () => {},
  signOut: async () => {},
  refresh: async () => {},
});

export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionState | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await api.session());
    } catch {
      // A station that cannot be reached is not the same as being signed out,
      // so the last known answer is kept rather than bouncing the operator to
      // a login screen every time the link drops.
      setState((previous: SessionState | null) => previous);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const signIn = useCallback(async (key: string) => {
    await api.login(key);
    await refresh();
  }, [refresh]);

  const enterAsObserver = useCallback(async () => {
    await api.enterAsObserver();
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      await refresh();
    }
  }, [refresh]);

  /*
   * Tell the API layer what this session may do.
   *
   * Only consulted when a mutation is about to be queued during an outage —
   * online, the station answers for itself. Kept in a ref-like module slot
   * rather than passed down, for the same reason `setHeaderFactory` is: the
   * request helper is a plain module and has no way to read context.
   *
   * `state === null` means the console has not heard back — often because
   * the link is down — and that is deliberately treated as permissive. A
   * commander whose console reloaded mid-outage must not have their work
   * refused because the session probe could not complete.
   */
  useEffect(() => {
    setWriteGuard(() => {
      if (state === null || state.can_write) return null;
      return state.authenticated
        ? 'You are viewing this station as an observer, which is read-only. '
          + 'Sign in with the commander key to change the record.'
        : 'You are reading this station without a session, so that change cannot be '
          + 'held for it. Sign in with the commander key to make changes.';
    });
  }, [state]);

  // A session expires while the console is open. Rather than let every module
  // start failing with 401s that read like outages, the expiry is noticed
  // centrally and the operator is asked to sign in again.
  useEffect(() => {
    const onUnauthorised = (event: Event) => {
      const error = (event as CustomEvent<ApiError>).detail;
      if (error?.status === 401) void refresh();
    };
    window.addEventListener('prahari:unauthorised', onUnauthorised);
    return () => window.removeEventListener('prahari:unauthorised', onUnauthorised);
  }, [refresh]);

  const value = useMemo<SessionContextValue>(() => ({
    state,
    ready,
    authenticated: state?.authenticated ?? false,
    // Defaults to false: a console that has not heard back must not offer a
    // control the station is going to refuse.
    canWrite: state?.can_write ?? false,
    isObserver: state?.role === 'observer',
    signIn,
    enterAsObserver,
    signOut,
    refresh,
  }), [state, ready, signIn, enterAsObserver, signOut, refresh]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
