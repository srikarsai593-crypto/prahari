import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CrossStationDialog, HeadcountChip, STOCK_STATE_LABEL, STOCK_STATE_TEXT, ThermalLoadControl,
  stateOf,
} from './InventoryControls';
import { ToastProvider } from './Toast';
import { api } from '@/lib/api';
import type { CrossStationStock, InventoryItem } from '@/lib/types';

const withToasts = (ui: React.ReactElement) => render(<ToastProvider>{ui}</ToastProvider>);

const item = (overrides: Partial<InventoryItem> = {}): InventoryItem => ({
  id: 'inv-fuel', name: 'Diesel Fuel', category: 'consumable', station: 'Maitri',
  quantity: 6500, unit: 'L', base_burn_rate: 350, beta: 0.15,
  days_of_cover: 18.6, updated_at: '2026-09-27T10:00:00.000Z',
  ...overrides,
});

describe('stateOf', () => {
  it('trusts the station verdict rather than recomputing it', () => {
    /**
     * The policy band is a domain decision made once, on the backend, against
     * the row's class and any floor the station has set. Re-deriving it in the
     * browser is how the two drift apart and the table disagrees with the
     * alert banner above it.
     */
    expect(stateOf(item({ stock_state: 'critical', days_of_cover: 90 }))).toBe('critical');
    expect(stateOf(item({ stock_state: 'nominal', days_of_cover: 2 }))).toBe('nominal');
  });

  it('falls back to the flat rule only for a row the station has not classified', () => {
    expect(stateOf(item({ stock_state: undefined, days_of_cover: 8 }))).toBe('critical');
    expect(stateOf(item({ stock_state: undefined, days_of_cover: 40 }))).toBe('nominal');
  });

  it('does not call a row with no cover figure critical', () => {
    // Unknown is not the same as bad; a reusable item with no burn rate has no
    // meaningful runway and must not render as an emergency.
    expect(stateOf(item({ stock_state: undefined, days_of_cover: null }))).toBe('nominal');
  });
});

describe('state presentation', () => {
  it('gives each band its own label and colour', () => {
    const labels = Object.values(STOCK_STATE_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
    const colours = Object.values(STOCK_STATE_TEXT);
    expect(new Set(colours).size).toBe(colours.length);
  });

  it('reads critical as red and nominal as green', () => {
    expect(STOCK_STATE_TEXT.critical).toContain('rose');
    expect(STOCK_STATE_TEXT.nominal).toContain('emerald');
  });
});

describe('HeadcountChip', () => {
  it('says nothing when the station has not reported a basis', () => {
    const { container } = render(<HeadcountChip basis={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows what the burn rate is scaled against', () => {
    /**
     * A runway that halved because eight people arrived reads identically to
     * one halved by a blizzard unless the basis is on screen.
     */
    render(<HeadcountChip basis={{ station: 'Maitri', headcount: 6,
                                   nominal_headcount: 6, factor: 1 }} />);
    expect(screen.getByText(/6 crew/)).toBeInTheDocument();
  });

  it('gives the multiplier only when the rates have actually moved', () => {
    /**
     * At the nominal headcount the factor is 1, and printing "1.00x" is the
     * loudest thing on a chip that is reporting nothing has changed.
     */
    const { container: nominal } = render(
      <HeadcountChip basis={{ station: 'Maitri', headcount: 6,
                              nominal_headcount: 6, factor: 1 }} />);
    expect(nominal.textContent).not.toMatch(/×/);

    render(<HeadcountChip basis={{ station: 'Maitri', headcount: 12,
                                   nominal_headcount: 6, factor: 2 }} />);
    expect(screen.getByText(/2\.00× the usual/)).toBeInTheDocument();
  });

  it('marks an over-occupied station differently from an empty one', () => {
    const { container: busy } = render(
      <HeadcountChip basis={{ station: 'Maitri', headcount: 12,
                              nominal_headcount: 6, factor: 2 }} />);
    const { container: quiet } = render(
      <HeadcountChip basis={{ station: 'Maitri', headcount: 2,
                              nominal_headcount: 6, factor: 0.33 }} />);
    expect(busy.innerHTML).not.toBe(quiet.innerHTML);
    expect(busy.querySelector('span')?.className).toContain('amber');
  });

  it('explains itself on hover for an operator who has not seen it before', () => {
    render(<HeadcountChip basis={{ station: 'Maitri', headcount: 6,
                                   nominal_headcount: 6, factor: 1 }} />);
    expect(screen.getByTitle(/scaled by live crew on station/i)).toBeInTheDocument();
  });
});


describe('ThermalLoadControl', () => {
  beforeEach(() => {
    vi.spyOn(api, 'applyStationWeather').mockResolvedValue({
      station: 'Maitri', delta_t: 30, affected: 2, delayed: 1, rescored: [],
      degraded_expeditions: [],
    });
  });

  it('follows the station reading rather than overriding it', async () => {
    /**
     * Another console, or the Cargo page, setting the weather has to move this
     * slider. A control that keeps its own idea of the truth quietly reverts
     * somebody else's change on the next apply.
     */
    const { rerender } = withToasts(
      <ThermalLoadControl stationId="Maitri" stationLabel="Maitri Base"
                          deltaT={0} onApplied={vi.fn()} />);
    expect(screen.getByLabelText(/blizzard load/i)).toHaveValue('0');

    rerender(
      <ToastProvider>
        <ThermalLoadControl stationId="Maitri" stationLabel="Maitri Base"
                            deltaT={26} onApplied={vi.fn()} />
      </ToastProvider>);
    await waitFor(() => expect(screen.getByLabelText(/blizzard load/i)).toHaveValue('26'));
  });

  it('applies a preset straight to the station', async () => {
    const onApplied = vi.fn();
    withToasts(<ThermalLoadControl stationId="Maitri" stationLabel="Maitri Base"
                                   deltaT={0} onApplied={onApplied} />);

    await userEvent.click(screen.getByRole('button', { name: /whiteout/i }));

    await waitFor(() => expect(api.applyStationWeather).toHaveBeenCalledWith('Maitri', 30));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('reports what the blizzard did downstream, not only that it applied', async () => {
    vi.spyOn(api, 'applyStationWeather').mockResolvedValue({
      station: 'Maitri', delta_t: 40, affected: 2, delayed: 1, rescored: [],
      degraded_expeditions: [{ expedition_id: 'exp-1', name: 'Survey Alpha',
                               station: 'Maitri', status: 'draft',
                               baseline_readiness: 100, live_readiness: 40,
                               degraded: true, shortfalls: [] }],
    });
    withToasts(<ThermalLoadControl stationId="Maitri" stationLabel="Maitri Base"
                                   deltaT={0} onApplied={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /apply to station/i }));

    expect(await screen.findByText(/no longer viable/i)).toBeInTheDocument();
  });

  it('does not claim a re-score that is still sitting in the offline queue', async () => {
    /**
     * A queued mutation resolves to the queue marker, not to a server
     * response. Reading `affected` and `delayed` off it printed "undefined
     * consignment(s) re-scored, undefined delayed" — a figure the operator had
     * no way to tell from a real one.
     */
    vi.spyOn(api, 'applyStationWeather').mockResolvedValue(
      { queued: true, pending: true } as never);
    withToasts(<ThermalLoadControl stationId="Maitri" stationLabel="Maitri Base"
                                   deltaT={0} onApplied={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /apply to station/i }));

    expect(await screen.findByText(/held on this console/i)).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('says when the station has never reported a reading', () => {
    // Absence of a reading is not the same as calm weather.
    withToasts(<ThermalLoadControl stationId="Maitri" stationLabel="Maitri Base"
                                   deltaT={null} onApplied={vi.fn()} />);
    expect(screen.getByText(/no reading/i)).toBeInTheDocument();
  });

  it('bands the severity so the figure is not read alone', () => {
    withToasts(<ThermalLoadControl stationId="Maitri" stationLabel="Maitri Base"
                                   deltaT={30} onApplied={vi.fn()} />);
    expect(screen.getByText('SEVERE')).toBeInTheDocument();
  });

  it('surfaces a refusal instead of appearing to succeed', async () => {
    vi.spyOn(api, 'applyStationWeather').mockRejectedValue(new Error('Station refused'));
    withToasts(<ThermalLoadControl stationId="Maitri" stationLabel="Maitri Base"
                                   deltaT={0} onApplied={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /apply to station/i }));

    expect(await screen.findByText(/station refused/i)).toBeInTheDocument();
  });
});

describe('CrossStationDialog', () => {
  const stock = (station: string, quantity: number, days: number,
                 state: InventoryItem['stock_state'], unit = 'L'): InventoryItem =>
    item({ id: `inv-${station}`, station, quantity, unit,
           days_of_cover: days, stock_state: state });

  const comparison = (overrides: Partial<CrossStationStock> = {}): CrossStationStock => ({
    query: 'Diesel Fuel',
    matched: 3,
    items: [stock('Bharati', 9200, 32.9, 'nominal'),
            stock('Himadri', 3100, 22.1, 'depleting'),
            stock('Maitri', 1500, 0.8, 'critical')],
    units: ['L'],
    best_source: 'Bharati',
    ...overrides,
  });

  it('lays the item out across every station that holds it', async () => {
    vi.spyOn(api, 'crossStationStock').mockResolvedValue(comparison());
    withToasts(<CrossStationDialog itemName="Diesel Fuel" homeStation="Maitri"
                                   onClose={vi.fn()} />);

    // "Bharati Station" also appears in the transfer advice below the table,
    // so the row itself is what is being asserted here.
    expect(await screen.findAllByText('Bharati Station')).not.toHaveLength(0);
    expect(screen.getByText('Himadri Station')).toBeInTheDocument();
    expect(screen.getByText(/this console/i)).toBeInTheDocument();
    expect(screen.getByText('9,200 L')).toBeInTheDocument();
    expect(screen.getByText(/0\.8d cover/)).toBeInTheDocument();
  });

  it('points at the deepest reserve', async () => {
    vi.spyOn(api, 'crossStationStock').mockResolvedValue(comparison());
    withToasts(<CrossStationDialog itemName="Diesel Fuel" homeStation="Maitri"
                                   onClose={vi.fn()} />);
    expect(await screen.findByText(/holds the deepest reserve/i)).toBeInTheDocument();
  });

  it('does not suggest a transfer from the station already being looked at', async () => {
    vi.spyOn(api, 'crossStationStock').mockResolvedValue(comparison({ best_source: 'Maitri' }));
    withToasts(<CrossStationDialog itemName="Diesel Fuel" homeStation="Maitri"
                                   onClose={vi.fn()} />);
    await screen.findByText('Himadri Station');
    expect(screen.queryByText(/holds the deepest reserve/i)).not.toBeInTheDocument();
  });

  it('warns when the rows are counted in different units', async () => {
    /**
     * Litres and kilograms do not compare, and a side-by-side table invites
     * exactly that comparison.
     */
    vi.spyOn(api, 'crossStationStock').mockResolvedValue(comparison({ units: ['L', 'kg'] }));
    withToasts(<CrossStationDialog itemName="Fuel" homeStation="Maitri" onClose={vi.fn()} />);
    expect(await screen.findByText(/counted in different units/i)).toBeInTheDocument();
  });

  it('says plainly when no station holds it', async () => {
    vi.spyOn(api, 'crossStationStock').mockResolvedValue(
      comparison({ matched: 0, items: [], best_source: null }));
    withToasts(<CrossStationDialog itemName="Unobtanium" homeStation="Maitri"
                                   onClose={vi.fn()} />);
    expect(await screen.findByText(/no station holds anything matching/i)).toBeInTheDocument();
  });

  it('closes on Escape, so it cannot trap an operator during an incident', async () => {
    vi.spyOn(api, 'crossStationStock').mockResolvedValue(comparison());
    const onClose = vi.fn();
    withToasts(<CrossStationDialog itemName="Diesel Fuel" homeStation="Maitri"
                                   onClose={onClose} />);
    await screen.findByRole('dialog');

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('is announced to assistive technology as a dialog', async () => {
    vi.spyOn(api, 'crossStationStock').mockResolvedValue(comparison());
    withToasts(<CrossStationDialog itemName="Diesel Fuel" homeStation="Maitri"
                                   onClose={vi.fn()} />);
    expect(await screen.findByRole('dialog')).toHaveAccessibleName(/diesel fuel/i);
  });
});
