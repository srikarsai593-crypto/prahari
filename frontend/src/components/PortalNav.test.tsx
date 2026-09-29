import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PortalNav } from './PortalNav';
import { SessionProvider } from './SessionProvider';
import { ToastProvider } from './Toast';
import { api } from '@/lib/api';
import type { SessionState } from '@/lib/types';

/**
 * The right-hand end of the navigation band: link state, the blackout drill,
 * and whether this console can change anything.
 *
 * The case these cover is a station serving open reads. There is no sign-in
 * wall then — the console opens straight onto the dashboard, which is the
 * right first impression — and it used to be a dead end: every write control
 * failed, no badge explained why, and there was nothing to press to fix it.
 */

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('./WebSocketProvider', () => ({
  useWebSocket: () => ({ connected: true, lastMessage: null, socket: null }),
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const signedOut: SessionState = {
  authenticated: false, actor: null, role: null, via: null, can_write: false,
  observer_enabled: false, public_reads: false,
  demo_key_enabled: true, demo_key: 'prahari-demo-2026',
  server_time: '2026-09-29T10:00:00.000Z',
};
const openReads: SessionState = { ...signedOut, public_reads: true };
const commander: SessionState = { ...signedOut, authenticated: true, actor: 'commander',
                                  role: 'commander', can_write: true, via: 'session' };
const observer: SessionState = { ...signedOut, authenticated: true, actor: 'observer',
                                 role: 'observer', can_write: false, via: 'session',
                                 observer_enabled: true };

const renderNav = () => render(
  <SessionProvider><ToastProvider><PortalNav /></ToastProvider></SessionProvider>,
);

beforeEach(() => {
  vi.spyOn(api, 'login').mockResolvedValue({ authenticated: true, actor: 'commander',
                                             expires_at: 0 });
  vi.spyOn(api, 'logout').mockResolvedValue({ authenticated: false });
});

describe('a console reading a station without a session', () => {
  beforeEach(() => { vi.spyOn(api, 'session').mockResolvedValue(openReads); });

  it('offers a way in, so the console is not a dead end', async () => {
    renderNav();
    await userEvent.click(await screen.findByRole('button', { name: /^sign in$/i }));
    expect(screen.getByRole('dialog', { name: /station sign-in/i })).toBeInTheDocument();
  });

  /**
   * The badge used to key on the observer role, so the one group with no way
   * to work out why their clicks did nothing — anonymous readers, who hold no
   * role at all — were the only group it never appeared for.
   */
  it('says it is read-only, though nobody here is an observer', async () => {
    renderNav();
    await waitFor(() => expect(screen.getByText(/read only/i)).toBeInTheDocument());
  });

  it('closes the dialog and drops both controls once somebody signs in', async () => {
    renderNav();
    await userEvent.click(await screen.findByRole('button', { name: /^sign in$/i }));

    vi.spyOn(api, 'session').mockResolvedValue(commander);
    await userEvent.click(
      screen.getByRole('button', { name: /sign in with the public demo key/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByText(/read only/i)).not.toBeInTheDocument();
  });

  /**
   * The close button is painted at the top-right but comes *after* the panel
   * in the DOM, so the focus trap lands on the key field. Somebody who opened
   * a sign-in dialog wants to type, not to be handed the control that throws
   * it away.
   */
  it('puts focus on the key field, not on the way out', async () => {
    renderNav();
    await userEvent.click(await screen.findByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(screen.getByLabelText(/commander key/i)).toHaveFocus());
  });

  it('can be dismissed without signing in', async () => {
    renderNav();
    await userEvent.click(await screen.findByRole('button', { name: /^sign in$/i }));
    await userEvent.click(screen.getByRole('button', { name: /close sign-in/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });
});

describe('a commander console', () => {
  beforeEach(() => { vi.spyOn(api, 'session').mockResolvedValue(commander); });

  it('is not told it is read-only, and is not offered a sign-in', async () => {
    renderNav();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument());
    expect(screen.queryByText(/read only/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).not.toBeInTheDocument();
  });

  it('can still reach the blackout drill', async () => {
    renderNav();
    expect(await screen.findByRole('switch', { name: /blackout/i })).toBeInTheDocument();
  });
});

describe('an observer console', () => {
  it('keeps the read-only badge, and is offered sign-out rather than sign-in', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(observer);
    renderNav();

    await waitFor(() => expect(screen.getByText(/read only/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).not.toBeInTheDocument();
  });
});
