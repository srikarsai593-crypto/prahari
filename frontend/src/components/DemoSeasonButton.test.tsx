import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { DemoSeasonButton } from './DemoSeasonButton';
import { ToastProvider } from './Toast';
import { api } from '@/lib/api';

/**
 * The control clears every operational record before it plants anything, so
 * what matters is that it says so and that it cannot be triggered by accident.
 */

const withToasts = (ui: React.ReactElement) => render(<ToastProvider>{ui}</ToastProvider>);

const loaded = {
  status: 'loaded',
  created: { shipments: 6, expeditions: 3, incidents: 3 },
  now: {
    movement_plans: 0, incidents: 3, shipments: 6, expeditions: 4,
    events: 16, open_incidents: 0,
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('DemoSeasonButton', () => {
  it('asks before it clears anything', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const load = vi.spyOn(api, 'loadDemoSeason');

    withToasts(<DemoSeasonButton />);
    await userEvent.click(screen.getByRole('button', { name: /load demo season/i }));

    expect(confirm).toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('says that it clears the existing records first', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    withToasts(<DemoSeasonButton />);
    await userEvent.click(screen.getByRole('button', { name: /load demo season/i }));

    // Destructive, and irreversible — an operator must not learn that after
    // the fact.
    const asked = confirm.mock.calls[0][0] as string;
    expect(asked).toMatch(/clears/i);
    expect(asked).toMatch(/cannot be undone/i);
  });

  it('reports what it planted rather than a bare success', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(api, 'loadDemoSeason').mockResolvedValue(loaded);

    withToasts(<DemoSeasonButton />);
    await userEvent.click(screen.getByRole('button', { name: /load demo season/i }));

    expect(await screen.findByText(/6 consignment\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/3 traverse\(s\)/)).toBeInTheDocument();
  });

  it('tells the caller to refresh, so the page does not keep the old figures', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(api, 'loadDemoSeason').mockResolvedValue(loaded);
    const onLoaded = vi.fn();

    withToasts(<DemoSeasonButton onLoaded={onLoaded} />);
    await userEvent.click(screen.getByRole('button', { name: /load demo season/i }));

    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
  });

  it('surfaces a refusal instead of appearing to have worked', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(api, 'loadDemoSeason').mockRejectedValue(new Error('Station write rejected'));
    const onLoaded = vi.fn();

    withToasts(<DemoSeasonButton onLoaded={onLoaded} />);
    await userEvent.click(screen.getByRole('button', { name: /load demo season/i }));

    expect(await screen.findByText(/station write rejected/i)).toBeInTheDocument();
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('cannot be fired twice while the first run is in flight', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let release: (v: typeof loaded) => void = () => {};
    vi.spyOn(api, 'loadDemoSeason').mockReturnValue(
      new Promise((resolve) => { release = resolve; }));

    withToasts(<DemoSeasonButton />);
    const button = screen.getByRole('button', { name: /load demo season/i });
    await userEvent.click(button);

    await waitFor(() => expect(screen.getByRole('button', { name: /loading/i })).toBeDisabled());
    release(loaded);
    await waitFor(() => expect(api.loadDemoSeason).toHaveBeenCalledTimes(1));
  });
});
