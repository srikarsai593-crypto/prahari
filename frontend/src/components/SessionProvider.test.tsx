import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionProvider, useSession } from './SessionProvider';
import { LoginGate } from './LoginGate';
import { api, ApiError } from '@/lib/api';
import { offlineQueue } from '@/lib/offlineQueue';
import type { SessionState } from '@/lib/types';

/**
 * The gate in front of a console that carries live positions for everyone on
 * the ice. Its two failure modes are opposite and both bad: letting someone
 * past without a session, and locking out an operator who has one.
 */

const signedOut: SessionState = {
  authenticated: false, actor: null, role: null, via: null, can_write: false,
  observer_enabled: false,
  public_reads: false, demo_key_enabled: true, demo_key: 'prahari-demo-2026',
  server_time: '2026-09-27T10:00:00.000Z',
};
const signedIn: SessionState = { ...signedOut, authenticated: true, actor: 'commander',
                                 role: 'commander', can_write: true, via: 'session' };
const observing: SessionState = { ...signedOut, authenticated: true, actor: 'observer',
                                  role: 'observer', can_write: false, via: 'session',
                                  observer_enabled: true };

function Console() {
  const { authenticated, state } = useSession();
  return <p>{`console for ${authenticated ? state?.actor : 'nobody'}`}</p>;
}

/**
 * "console for nobody" is what `Console` renders both before the session
 * probe answers and after it answers "not signed in", so waiting on it does
 * not prove the session has loaded — and a test that then depends on the
 * write guard, which the provider installs from that session, races it.
 * This reports something only a resolved probe can produce.
 */
function SessionLoaded() {
  const { ready, state } = useSession();
  return <p>{ready && state ? `loaded:${state.public_reads}` : 'loading'}</p>;
}

const renderGate = () => render(
  <SessionProvider><LoginGate><Console /></LoginGate></SessionProvider>,
);

beforeEach(() => {
  vi.spyOn(api, 'session').mockResolvedValue(signedOut);
  vi.spyOn(api, 'login').mockResolvedValue({ authenticated: true, actor: 'commander',
                                             expires_at: 0 });
  vi.spyOn(api, 'logout').mockResolvedValue({ authenticated: false });
});

describe('the gate', () => {
  it('holds the console back until the session probe answers', async () => {
    let settle: (state: SessionState) => void = () => {};
    vi.spyOn(api, 'session').mockReturnValue(
      new Promise<SessionState>((resolve) => { settle = resolve; }));

    renderGate();
    // No login form and no console: an operator who *is* signed in must not
    // see the sign-in screen flash before their dashboard.
    expect(screen.queryByLabelText(/commander key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/console for/)).not.toBeInTheDocument();

    settle(signedIn);
    await waitFor(() => expect(screen.getByText('console for commander')).toBeInTheDocument());
  });

  it('asks for the key when there is no session', async () => {
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());
    expect(screen.queryByText(/console for/)).not.toBeInTheDocument();
  });

  it('lets a signed-in operator straight through', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(signedIn);
    renderGate();
    await waitFor(() => expect(screen.getByText('console for commander')).toBeInTheDocument());
  });

  it('opens the console on a kiosk deployment where reads are public', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...signedOut, public_reads: true });
    renderGate();
    await waitFor(() => expect(screen.getByText('console for nobody')).toBeInTheDocument());
  });
});

describe('signing in', () => {
  it('exchanges the key and reveals the console', async () => {
    const session = vi.spyOn(api, 'session')
      .mockResolvedValueOnce(signedOut)
      .mockResolvedValue(signedIn);
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/commander key/i), 'prahari-demo-2026');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(screen.getByText('console for commander')).toBeInTheDocument());
    expect(api.login).toHaveBeenCalledWith('prahari-demo-2026');
    expect(session).toHaveBeenCalledTimes(2);
  });

  it('never holds the key after using it', async () => {
    vi.spyOn(api, 'session').mockResolvedValueOnce(signedOut).mockResolvedValue(signedIn);
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());
    const field = screen.getByLabelText(/commander key/i) as HTMLInputElement;

    await userEvent.type(field, 'prahari-demo-2026');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(screen.getByText('console for commander')).toBeInTheDocument());
    expect(window.localStorage.getItem('prahari_commander_key')).toBeNull();
    expect(JSON.stringify(window.localStorage)).not.toContain('prahari-demo-2026');
  });

  it('masks the field so the key is not shoulder-read', async () => {
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/commander key/i)).toHaveAttribute('type', 'password');
  });

  it('reports a rejected key without clearing what was typed', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(
      new ApiError('That is not the commander key for this station.', 401, '/api/auth/login'));
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/commander key/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByRole('alert'))
      .toHaveTextContent(/not the commander key/i);
    expect(screen.getByLabelText(/commander key/i)).toHaveValue('wrong');
  });

  it('does not call the station for an empty key', async () => {
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter the station commander key/i);
    expect(api.login).not.toHaveBeenCalled();
  });

  /**
   * On a station running the published key there is no secret to protect, and
   * making somebody retype a key this screen has just printed to them is the
   * first thing anyone handed the link meets. It is still the real exchange —
   * the same call, with the key the station reported.
   */
  it('signs in on the published demo key in one press', async () => {
    const login = vi.spyOn(api, 'login');
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /sign in with the public demo key/i }));
    expect(login).toHaveBeenCalledWith('prahari-demo-2026');
  });

  it('names the key it would use, rather than signing in with an unnamed one', async () => {
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());
    expect(screen.getByText('prahari-demo-2026')).toBeInTheDocument();
  });

  it('offers nothing when a real key is configured', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...signedOut, demo_key_enabled: false,
                                                 demo_key: null });
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());
    expect(screen.queryByText(/public demo key/i)).not.toBeInTheDocument();
  });
});

describe('observer access', () => {
  const offering: SessionState = { ...signedOut, observer_enabled: true };

  it('is not offered where the station does not allow it', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(signedOut);
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /enter as observer/i }))
      .not.toBeInTheDocument();
  });

  it('opens a read-only console without the key', async () => {
    /** Someone handed the link is otherwise met by a key prompt and a
     *  console correctly refusing to show them anything. */
    vi.spyOn(api, 'session').mockResolvedValueOnce(offering).mockResolvedValue(observing);
    vi.spyOn(api, 'enterAsObserver').mockResolvedValue({
      authenticated: true, actor: 'observer', role: 'observer', can_write: false,
    });
    renderGate();
    await waitFor(() => expect(
      screen.getByRole('button', { name: /enter as observer/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /enter as observer/i }));

    await waitFor(() => expect(screen.getByText('console for observer')).toBeInTheDocument());
    expect(api.enterAsObserver).toHaveBeenCalled();
  });

  it('says plainly that it changes nothing', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(offering);
    renderGate();
    await waitFor(() => expect(screen.getByText(/read-only/i)).toBeInTheDocument());
    expect(screen.getByText(/change nothing/i)).toBeInTheDocument();
  });

  it('surfaces a station that refuses rather than hanging', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(offering);
    vi.spyOn(api, 'enterAsObserver')
      .mockRejectedValue(new Error('This station does not offer observer access.'));
    renderGate();
    await waitFor(() => expect(
      screen.getByRole('button', { name: /enter as observer/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /enter as observer/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/does not offer observer/i);
  });
});

describe('what a session may do', () => {
  function Permissions() {
    const { canWrite, isObserver } = useSession();
    return <p>{`write=${canWrite} observer=${isObserver}`}</p>;
  }
  const renderPermissions = () => render(
    <SessionProvider><Permissions /></SessionProvider>,
  );

  it('reports a commander as able to write', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(signedIn);
    renderPermissions();
    await waitFor(() => expect(
      screen.getByText('write=true observer=false')).toBeInTheDocument());
  });

  it('reports an observer as signed in and unable to write', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(observing);
    renderPermissions();
    await waitFor(() => expect(
      screen.getByText('write=false observer=true')).toBeInTheDocument());
  });

  it('assumes it may not write until the station has answered', async () => {
    /** A console that has not heard back must not offer a control the
     *  station is going to refuse. */
    vi.spyOn(api, 'session').mockRejectedValue(new Error('unreachable'));
    renderPermissions();
    await waitFor(() => expect(
      screen.getByText('write=false observer=false')).toBeInTheDocument());
  });
});

describe('losing the session', () => {
  it('re-probes when a module reports a 401', async () => {
    /**
     * A session that lapses mid-shift otherwise surfaces as a dozen unrelated
     * module failures that each read like an outage.
     */
    const session = vi.spyOn(api, 'session').mockResolvedValue(signedIn);
    renderGate();
    await waitFor(() => expect(screen.getByText('console for commander')).toBeInTheDocument());

    session.mockResolvedValue(signedOut);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('prahari:unauthorised', {
        detail: new ApiError('expired', 401, '/api/personnel'),
      }));
    });

    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());
  });

  it('ignores failures that are not about credentials', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(signedIn);
    renderGate();
    await waitFor(() => expect(screen.getByText('console for commander')).toBeInTheDocument());

    await act(async () => {
      window.dispatchEvent(new CustomEvent('prahari:unauthorised', {
        detail: new ApiError('server error', 500, '/api/personnel'),
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByText('console for commander')).toBeInTheDocument();
  });

  it('does not sign an operator out because the link dropped', async () => {
    /**
     * A station that cannot be reached is not the same as being signed out.
     * Bouncing to a login screen every time the satellite link blinks is the
     * opposite of an offline-first console.
     */
    const session = vi.spyOn(api, 'session').mockResolvedValue(signedIn);
    renderGate();
    await waitFor(() => expect(screen.getByText('console for commander')).toBeInTheDocument());

    session.mockRejectedValue(new ApiError('Cannot reach the station', 0, '/api/auth/session'));
    await act(async () => {
      window.dispatchEvent(new CustomEvent('prahari:unauthorised', {
        detail: new ApiError('unauthorised', 401, '/api/personnel'),
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByText('console for commander')).toBeInTheDocument();
  });
});

/**
 * The offline queue has no way to reach React context, so the provider pushes
 * the session's write permission down to the API layer. If that wiring breaks,
 * nothing fails loudly — an observer simply goes back to having their writes
 * parked forever during an outage.
 */
describe('telling the API layer what this session may do', () => {
  /**
   * What the console does with a write it cannot send during an outage.
   *
   * The flush is load-bearing. The provider installs the write guard from an
   * effect, and the text each test waits on is rendered by the commit that
   * *schedules* that effect — so a probe fired the moment the text appears
   * can land in the window where the session has arrived and the guard has
   * not, read the permissive default, and park a write the console would in
   * fact have refused. It failed about one run in five, and only under the
   * full suite, where the extra load widened the window.
   *
   * Flushing rather than polling the behaviour: a poll would let the two
   * cases that expect "parked" pass on the default before the guard was
   * installed at all, which is the assertion those tests exist to make.
   */
  const queuedWriteDuringOutage = async () => {
    await act(async () => {});
    await offlineQueue.setOffline(true);
    try {
      await api.loadDemoSeason();
      return 'parked';
    } catch (e) {
      return e instanceof ApiError && e.status === 403 ? 'refused' : 'other';
    } finally {
      await offlineQueue.setOffline(false);
      offlineQueue.clear();
    }
  };

  it('parks an outage write for a commander', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(signedIn);
    render(<SessionProvider><Console /></SessionProvider>);
    await waitFor(() => expect(screen.getByText(/console for commander/)).toBeInTheDocument());

    await expect(queuedWriteDuringOutage()).resolves.toBe('parked');
  });

  it('refuses an outage write for an observer rather than promising to send it', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(observing);
    render(<SessionProvider><Console /></SessionProvider>);
    await waitFor(() => expect(screen.getByText(/console for observer/)).toBeInTheDocument());

    await expect(queuedWriteDuringOutage()).resolves.toBe('refused');
  });

  /**
   * A console reloaded while the link is already down never hears back from
   * /auth/session. Refusing a commander's work over that is the worse of the
   * two failures, so an unknown session is treated as permitted.
   */
  it('parks the write when it could not find out who is signed in', async () => {
    vi.spyOn(api, 'session').mockRejectedValue(new Error('link down'));
    render(<SessionProvider><Console /></SessionProvider>);
    await waitFor(() => expect(screen.getByText(/console for nobody/)).toBeInTheDocument());

    await expect(queuedWriteDuringOutage()).resolves.toBe('parked');
  });
});

/**
 * A station serving open reads (PRAHARI_PUBLIC_READS) shows the console to
 * anyone with the link — which is the right first impression, and was also a
 * dead end: no wall meant no sign-in, so every write control failed with
 * nothing on the page to press and nothing explaining why.
 */
const openReads: SessionState = { ...signedOut, public_reads: true };

describe('a station that serves reads without a session', () => {
  it('shows the console rather than a sign-in wall', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(openReads);
    render(<SessionProvider><LoginGate><Console /></LoginGate></SessionProvider>);

    await waitFor(() => expect(screen.getByText(/console for nobody/)).toBeInTheDocument());
    expect(screen.queryByLabelText(/commander key/i)).not.toBeInTheDocument();
  });

  it('refuses an outage write in words that fit having no session', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(openReads);
    render(<SessionProvider><SessionLoaded /></SessionProvider>);
    await waitFor(() => expect(screen.getByText('loaded:true')).toBeInTheDocument());
    await act(async () => {});   // see queuedWriteDuringOutage for why

    await offlineQueue.setOffline(true);
    try {
      await expect(api.loadDemoSeason()).rejects.toThrow(/without a session/i);
      expect(offlineQueue.pendingCount).toBe(0);
    } finally {
      await offlineQueue.setOffline(false);
      offlineQueue.clear();
    }
  });

});
