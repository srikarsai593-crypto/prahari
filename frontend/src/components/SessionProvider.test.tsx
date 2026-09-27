import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionProvider, useSession } from './SessionProvider';
import { LoginGate } from './LoginGate';
import { api, ApiError } from '@/lib/api';
import type { SessionState } from '@/lib/types';

/**
 * The gate in front of a console that carries live positions for everyone on
 * the ice. Its two failure modes are opposite and both bad: letting someone
 * past without a session, and locking out an operator who has one.
 */

const signedOut: SessionState = {
  authenticated: false, actor: null, via: null,
  public_reads: false, demo_key_enabled: true, demo_key: 'prahari-demo-2026',
  server_time: '2026-09-27T10:00:00.000Z',
};
const signedIn: SessionState = { ...signedOut, authenticated: true, actor: 'commander',
                                 via: 'session' };

function Console() {
  const { authenticated, state } = useSession();
  return <p>{`console for ${authenticated ? state?.actor : 'nobody'}`}</p>;
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
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

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
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

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
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert'))
      .toHaveTextContent(/not the commander key/i);
    expect(screen.getByLabelText(/commander key/i)).toHaveValue('wrong');
  });

  it('does not call the station for an empty key', async () => {
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter the station commander key/i);
    expect(api.login).not.toHaveBeenCalled();
  });

  it('offers the demo key only where the station says it is in use', async () => {
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'prahari-demo-2026' }));
    expect(screen.getByLabelText(/commander key/i)).toHaveValue('prahari-demo-2026');
  });

  it('offers nothing when a real key is configured', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...signedOut, demo_key_enabled: false,
                                                 demo_key: null });
    renderGate();
    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toBeInTheDocument());
    expect(screen.queryByText(/public demo key/i)).not.toBeInTheDocument();
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
