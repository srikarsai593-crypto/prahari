import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@/components/Toast';
import { useBlackoutDrill } from './useBlackoutDrill';
import { offlineQueue } from './offlineQueue';

/**
 * What the console says when the link comes back.
 *
 * The claim the whole offline story rests on is that work done during an
 * outage is not lost. The restore toast is where that claim is either made
 * good or quietly fudged — so the figures in it are the replay's real
 * figures, including the unflattering ones.
 */

/* The hook calls useToast, so it has to be mounted inside the provider
   rather than beside it. */
function Wrapped() {
  return <ToastProvider><Drill /></ToastProvider>;
}

function Drill() {
  const { blackout, pending, toggle } = useBlackoutDrill();
  return (
    <>
      <button type="button" onClick={() => void toggle()}>
        {blackout ? 'Restore link' : 'Simulate blackout'}
      </button>
      <span data-testid="pending">{pending}</span>
    </>
  );
}

const press = (name: RegExp) => userEvent.click(screen.getByRole('button', { name }));

afterEach(async () => {
  await act(async () => {
    await offlineQueue.setBlackout(false);
    offlineQueue.clear();
  });
});

describe('useBlackoutDrill', () => {
  it('holds writes rather than losing them, and says so', async () => {
    render(<Wrapped />);
    await press(/simulate blackout/i);

    expect(screen.getByText(/writes are being held on this console/i)).toBeInTheDocument();

    act(() => { offlineQueue.enqueue('/api/a', { method: 'POST' }, 'stock change'); });
    expect(screen.getByTestId('pending')).toHaveTextContent('1');
  });

  it('leads with the number of changes that arrived', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      { ok: true, status: 200, json: async () => ({}) }));

    render(<Wrapped />);
    await press(/simulate blackout/i);
    act(() => {
      offlineQueue.enqueue('/api/a', { method: 'POST' }, 'a');
      offlineQueue.enqueue('/api/b', { method: 'POST' }, 'b');
      offlineQueue.enqueue('/api/c', { method: 'POST' }, 'c');
    });

    await press(/restore link/i);
    expect(await screen.findByText(/^3 queued changes synced/)).toBeInTheDocument();
  });

  it('counts one change as one change', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      { ok: true, status: 200, json: async () => ({}) }));

    render(<Wrapped />);
    await press(/simulate blackout/i);
    act(() => { offlineQueue.enqueue('/api/a', { method: 'POST' }, 'a'); });

    await press(/restore link/i);
    expect(await screen.findByText(/^1 queued change synced/)).toBeInTheDocument();
  });

  it('does not congratulate itself over an outage in which nothing happened', async () => {
    render(<Wrapped />);
    await press(/simulate blackout/i);
    await press(/restore link/i);

    expect(await screen.findByText(/nothing was written while the link was down/i))
      .toBeInTheDocument();
  });

  /**
   * The failure this exists to prevent: a green tick over work the station
   * refused. A replay that lost something has to say so in the same breath as
   * the count, or the operator walks away believing the queue drained.
   */
  it('admits what the station refused', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));

    render(<Wrapped />);
    await press(/simulate blackout/i);
    act(() => {
      offlineQueue.enqueue('/api/a', { method: 'POST' }, 'a');
      offlineQueue.enqueue('/api/b', { method: 'POST' }, 'b');
    });

    await press(/restore link/i);
    const toast = await screen.findByText(/1 queued change synced/);
    expect(toast).toHaveTextContent(/1 rejected by the station/i);
  });

  it('admits what is still waiting when the link did not really come back', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockRejectedValue(new Error('network down')));

    render(<Wrapped />);
    await press(/simulate blackout/i);
    act(() => {
      offlineQueue.enqueue('/api/a', { method: 'POST' }, 'a');
      offlineQueue.enqueue('/api/b', { method: 'POST' }, 'b');
    });

    await press(/restore link/i);
    const toast = await screen.findByText(/1 queued change synced/);
    expect(toast).toHaveTextContent(/1 still queued/i);
  });
});
