import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { WhatIfPanel } from './WhatIfPanel';
import { ToastProvider } from './Toast';
import { api } from '@/lib/api';
import type { WhatIfResult } from '@/lib/types';

/**
 * A projection that does not say what it is gets read as a reading, and a
 * figure with no statement of its assumptions is one nobody should act on.
 * Both are what these pin.
 */

const withToasts = (ui: React.ReactElement) => render(<ToastProvider>{ui}</ToastProvider>);

const result = (over: Partial<WhatIfResult> = {}): WhatIfResult => ({
  station: 'Maitri',
  scenario: { extra_crew: 6, advance_days: 7 },
  assumptions: ['crew on station 6 -> 12', '7 day(s) of consumption at the new rate'],
  inventory: [
    { id: 'inv-fuel', name: 'Diesel Fuel', unit: 'L',
      before: { quantity: 6500, days_of_cover: 18.6, depletion_rate: 350, stock_state: 'nominal' },
      after: { quantity: 3000, days_of_cover: 6.2, depletion_rate: 480, stock_state: 'critical' },
      cover_change_days: -12.4, newly_critical: true },
    { id: 'inv-blankets', name: 'Thermal Blankets', unit: 'units',
      before: { quantity: 45, days_of_cover: 90, depletion_rate: 0.5, stock_state: 'nominal' },
      after: { quantity: 45, days_of_cover: 90, depletion_rate: 0.5, stock_state: 'nominal' },
      cover_change_days: 0, newly_critical: false },
  ],
  expeditions: [
    { id: 'exp-1', name: 'Ice Core Traverse', status: 'draft',
      before_readiness: 96, after_readiness: 61, readiness_change: -35,
      newly_short: ['Fuel'], resolved: [], blocked: true },
  ],
  summary: { items_newly_critical: 1, traverses_newly_blocked: 1,
             worst_cover_change_days: -12.4, worst_readiness_change: -35 },
  is_projection: true,
  persisted: false,
  ...over,
});

const panel = () => withToasts(
  <WhatIfPanel stationId="Maitri" stationLabel="Maitri Base" />,
);

beforeEach(() => { vi.restoreAllMocks(); });

describe('WhatIfPanel', () => {
  it('says up front that nothing is saved', () => {
    panel();
    expect(screen.getByText(/nothing is saved/i)).toBeInTheDocument();
  });

  it('labels the result a projection', async () => {
    /** A figure that does not say what it is gets read as a reading. */
    vi.spyOn(api, 'whatIf').mockResolvedValue(result());
    panel();
    await userEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(await screen.findByText('Projection')).toBeInTheDocument();
    expect(screen.getByText(/nothing was saved/i)).toBeInTheDocument();
  });

  it('shows what the projection took as given', async () => {
    vi.spyOn(api, 'whatIf').mockResolvedValue(result());
    panel();
    await userEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(await screen.findByText(/crew on station 6 -> 12/)).toBeInTheDocument();
  });

  it('shows before and after for what moved', async () => {
    vi.spyOn(api, 'whatIf').mockResolvedValue(result());
    panel();
    await userEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(await screen.findByText('18.6d')).toBeInTheDocument();
    expect(screen.getByText('6.2d')).toBeInTheDocument();
  });

  it('leaves out rows the scenario did not move', async () => {
    /** A table of unchanged rows buries the one that matters. */
    vi.spyOn(api, 'whatIf').mockResolvedValue(result());
    panel();
    await userEvent.click(screen.getByRole('button', { name: 'Project' }));
    await screen.findByText('Diesel Fuel');
    expect(screen.queryByText('Thermal Blankets')).not.toBeInTheDocument();
  });

  it('calls out a row that would turn critical', async () => {
    vi.spyOn(api, 'whatIf').mockResolvedValue(result());
    panel();
    await userEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(await screen.findByText(/would turn critical/i)).toBeInTheDocument();
  });

  it('names what a traverse would fall short on', async () => {
    vi.spyOn(api, 'whatIf').mockResolvedValue(result());
    panel();
    await userEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(await screen.findByText(/would fall short on Fuel/i)).toBeInTheDocument();
  });

  it('says plainly when a scenario changes nothing', async () => {
    vi.spyOn(api, 'whatIf').mockResolvedValue(result({
      inventory: [], expeditions: [],
      summary: { items_newly_critical: 0, traverses_newly_blocked: 0,
                 worst_cover_change_days: 0, worst_readiness_change: 0 },
    }));
    panel();
    await userEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(await screen.findByText(/nothing on this station moves/i)).toBeInTheDocument();
  });

  it('runs a preset as one click', async () => {
    const whatIf = vi.spyOn(api, 'whatIf').mockResolvedValue(result());
    panel();
    await userEvent.click(screen.getByRole('button', { name: /ship slips 10 days/i }));
    await waitFor(() => expect(whatIf).toHaveBeenCalledWith('Maitri',
      expect.objectContaining({ cargo_delay_hours: 240, advance_days: 10 })));
  });

  it('does not show a stale answer when the link is down', async () => {
    /** The projection runs on the station. A stale what-if is worse than
     *  no what-if. */
    vi.spyOn(api, 'whatIf').mockResolvedValue({ queued: true, pending: true } as never);
    panel();
    await userEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(await screen.findByText(/cannot be scored/i)).toBeInTheDocument();
    expect(screen.queryByText('Projection')).not.toBeInTheDocument();
  });

  it('surfaces a refusal rather than hanging', async () => {
    vi.spyOn(api, 'whatIf').mockRejectedValue(new Error('Station unreachable'));
    panel();
    await userEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(await screen.findByText(/station unreachable/i)).toBeInTheDocument();
  });
});
