import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { __resetStationConditions, useStationConditions } from './useStationConditions';
import { api } from './api';

/**
 * Four components read the blizzard ΔT. They used to fetch it four times.
 */

vi.mock('@/components/WebSocketProvider', () => ({
  useWebSocket: () => ({ lastMessage: null, connected: true }),
}));

function Reader({ station = 'Maitri' }: { station?: string }) {
  const { deltaT } = useStationConditions(station);
  return <span>{deltaT === null ? 'no reading' : `dT ${deltaT}`}</span>;
}

beforeEach(() => { __resetStationConditions(); vi.restoreAllMocks(); });
afterEach(() => { __resetStationConditions(); });

describe('sharing the request', () => {
  it('makes one call however many components ask at once', async () => {
    const spy = vi.spyOn(api, 'getStationConditions')
      .mockResolvedValue({ stations: { Maitri: 6, Bharati: 12 } });

    render(<><Reader /><Reader /><Reader /><Reader /></>);

    await waitFor(() => expect(screen.getAllByText('dT 6')).toHaveLength(4));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('gives every reader the same figure', async () => {
    vi.spyOn(api, 'getStationConditions')
      .mockResolvedValue({ stations: { Maitri: 6, Bharati: 12 } });

    render(<><Reader station="Maitri" /><Reader station="Bharati" /></>);

    await waitFor(() => expect(screen.getByText('dT 6')).toBeInTheDocument());
    expect(screen.getByText('dT 12')).toBeInTheDocument();
  });

  it('reports a station with no recorded load as calm, not unknown', async () => {
    vi.spyOn(api, 'getStationConditions').mockResolvedValue({ stations: { Maitri: 6 } });
    render(<Reader station="Himadri" />);
    await waitFor(() => expect(screen.getByText('dT 0')).toBeInTheDocument());
  });
});

describe('when the station cannot be reached', () => {
  it('keeps the last known reading rather than blanking it', async () => {
    /** A dropped link is not a reason to tell the header there is no
     *  weather — the crate risk on screen was scored against that figure. */
    const spy = vi.spyOn(api, 'getStationConditions')
      .mockResolvedValue({ stations: { Maitri: 6 } });
    const first = render(<Reader />);
    await waitFor(() => expect(screen.getByText('dT 6')).toBeInTheDocument());
    first.unmount();

    spy.mockRejectedValue(new Error('unreachable'));
    render(<Reader />);
    await waitFor(() => expect(screen.getByText('dT 6')).toBeInTheDocument());
  });

  it('says so plainly when nothing has ever been read', async () => {
    vi.spyOn(api, 'getStationConditions').mockRejectedValue(new Error('unreachable'));
    render(<Reader />);
    await waitFor(() => expect(screen.getByText('no reading')).toBeInTheDocument());
  });
});

describe('a component mounting later', () => {
  it('renders the known figure at once instead of flashing "no reading"', async () => {
    vi.spyOn(api, 'getStationConditions').mockResolvedValue({ stations: { Maitri: 6 } });
    render(<Reader />);
    await waitFor(() => expect(screen.getByText('dT 6')).toBeInTheDocument());

    // A second reader mounts after the cache is warm — on its very first
    // paint, before any request of its own settles.
    render(<Reader />);
    expect(screen.getAllByText('dT 6')).toHaveLength(2);
  });
});
