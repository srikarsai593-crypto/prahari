import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { BlackoutBanner } from './BlackoutBanner';
import { offlineQueue } from '@/lib/offlineQueue';

/**
 * The banner is the only part of an outage an operator can see.
 *
 * Everything it claims has to be the real queue: a console that says it is
 * holding three changes while holding none is worse than one that says
 * nothing, because the next person to sign in believes it.
 */

const goOffline = async () => { await act(async () => { await offlineQueue.setBlackout(true); }); };

// The queue is a module singleton, so one test's outage and one test's
// backlog both survive into the next. Both notify subscribers, which is a
// React state update and has to be wrapped like any other.
afterEach(async () => {
  await act(async () => {
    await offlineQueue.setBlackout(false);
    offlineQueue.clear();
  });
  delete document.documentElement.dataset.blackout;
});

describe('BlackoutBanner', () => {
  it('stays out of the way while the link is up', () => {
    render(<BlackoutBanner />);
    expect(screen.queryByText(/SATCOM LINK LOST/i)).not.toBeInTheDocument();
    expect(document.documentElement.dataset.blackout).toBeUndefined();
  });

  it('says the link is gone and what the console is running on', async () => {
    render(<BlackoutBanner />);
    await goOffline();
    expect(screen.getByText(/SATCOM LINK LOST/i)).toBeInTheDocument();
    expect(screen.getByText(/Operating on local cache/i)).toBeInTheDocument();
  });

  it('tints the whole console by marking the root, and clears it again', async () => {
    render(<BlackoutBanner />);
    await goOffline();
    expect(document.documentElement.dataset.blackout).toBe('on');

    await act(async () => { await offlineQueue.setBlackout(false); });
    expect(document.documentElement.dataset.blackout).toBeUndefined();
  });

  it('leaves no tint behind when it unmounts mid-outage', async () => {
    const { unmount } = render(<BlackoutBanner />);
    await goOffline();
    unmount();
    expect(document.documentElement.dataset.blackout).toBeUndefined();
  });

  it('counts the writes actually held, not the clicks', async () => {
    render(<BlackoutBanner />);
    await goOffline();
    expect(screen.getByText('0')).toBeInTheDocument();

    act(() => {
      offlineQueue.enqueue('/api/a', { method: 'POST' }, 'first');
      offlineQueue.enqueue('/api/b', { method: 'POST' }, 'second');
    });
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  /**
   * Reading a page needs nothing from the station, so a counter at zero while
   * somebody clicks through the modules is correct — and reads as broken.
   */
  it('asks for a write while the queue is empty, rather than sitting at zero', async () => {
    render(<BlackoutBanner />);
    await goOffline();
    expect(screen.getByText(/make a change/i)).toBeInTheDocument();

    act(() => { offlineQueue.enqueue('/api/a', { method: 'POST' }, 'first'); });
    expect(screen.queryByText(/make a change/i)).not.toBeInTheDocument();
    expect(screen.getByText(/queued locally/i)).toBeInTheDocument();
  });

  /**
   * A console tinted amber under a satellite warning is exactly the sort of
   * thing somebody walks past and reports. The difference between a
   * demonstration and a real failure has to be readable from the doorway.
   */
  it('marks an operator-forced outage as a drill', async () => {
    render(<BlackoutBanner />);
    await goOffline();
    expect(screen.getByText(/^drill$/i)).toBeInTheDocument();
  });

  it('does not call a genuine outage a drill', async () => {
    render(<BlackoutBanner />);
    await act(async () => { await offlineQueue.setOffline(true); });

    expect(screen.getByText(/SATCOM LINK LOST/i)).toBeInTheDocument();
    expect(screen.queryByText(/^drill$/i)).not.toBeInTheDocument();

    await act(async () => { await offlineQueue.setOffline(false); });
  });

  it('gives a screen reader the count as a sentence, not a bare digit', async () => {
    render(<BlackoutBanner />);
    await goOffline();
    act(() => { offlineQueue.enqueue('/api/a', { method: 'POST' }, 'first'); });

    expect(screen.getByText(/1 change is waiting on this console/i)).toBeInTheDocument();
  });
});
