import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { ColdChainCell } from './ColdChainCell';
import { ToastProvider } from './Toast';
import { api } from '@/lib/api';
import type { ColdChain, Shipment, TemperatureResult } from '@/lib/types';

/**
 * The failure this cell exists to prevent is a crate that spent six hours at
 * 15 °C being read as fine because it is 5 °C now.
 */

const withToasts = (ui: React.ReactElement) => render(<ToastProvider>{ui}</ToastProvider>);

const shipment = (cold: Partial<ColdChain> | null): Shipment => ({
  id: 'shp-1', barcode_id: 'SHP-2026-ABC123', expedition_id: null,
  item_name: 'Vaccine Pallet', category: 'medical', weight_kg: 180,
  quantity: 40, unit: 'units', inventory_item_id: 'inv-med', priority: 'high',
  origin_station: null, destination_station: 'Maitri', status: 'in_transit',
  dispatch_date: null, eta: null, risk_score: 0, delay_reason: null,
  last_scanned_at: null, updated_at: '2026-09-28T10:00:00.000Z',
  cold_chain: cold === null ? undefined : {
    monitored: true, state: 'within', last_temp_c: 5, temp_min: 2, temp_max: 8,
    excursion_count: 0, breach_summary: null, ...cold,
  } as ColdChain,
});

const reading = (over: Partial<TemperatureResult> = {}): TemperatureResult => ({
  temp_c: 5, band_state: 'within', deviation_c: 0, rate_c_per_h: null,
  breached: false, drifting: false, excursion: false, summary: 'within band',
  excursion_count: 0,
  cold_chain: { monitored: true, state: 'within', last_temp_c: 5, temp_min: 2,
                temp_max: 8, excursion_count: 0, breach_summary: null },
  ...over,
});

beforeEach(() => { vi.restoreAllMocks(); });

describe('ColdChainCell', () => {
  it('renders nothing for cargo that has no band', () => {
    /** Showing "no reading" against every crate of spares buries the handful
     *  that matter. */
    withToasts(<ColdChainCell shipment={shipment({ monitored: false, state: 'unmonitored' })}
                              onRecorded={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /record reading/i })).not.toBeInTheDocument();
  });

  it('shows the band so the reading can be judged against it', () => {
    withToasts(<ColdChainCell shipment={shipment({})} onRecorded={vi.fn()} />);
    expect(screen.getByText(/2…8°C/)).toBeInTheDocument();
  });

  it('tells a crate awaiting its first reading apart from one in band', () => {
    withToasts(<ColdChainCell
      shipment={shipment({ state: 'awaiting_reading', last_temp_c: null })}
      onRecorded={vi.fn()} />);
    expect(screen.getByText('No reading')).toBeInTheDocument();
  });

  it('keeps reporting an excursion after the crate has recovered', () => {
    /** The whole point: 5 °C now, and it was 15 °C for six hours. */
    withToasts(<ColdChainCell
      shipment={shipment({ state: 'within', last_temp_c: 5, excursion_count: 1,
                           breach_summary: '1 excursion(s) recorded in transit' })}
      onRecorded={vi.fn()} />);
    expect(screen.getByText('5°C')).toBeInTheDocument();
    expect(screen.getByText(/1 excursion\(s\) recorded in transit/)).toBeInTheDocument();
  });

  it('names where the last reading came from', () => {
    /** Prahari has no sensor network; a typed figure must not read as
     *  telemetry. */
    withToasts(<ColdChainCell shipment={shipment({ last_temp_source: 'logger' })}
                              onRecorded={vi.fn()} />);
    expect(screen.getByText(/logger/)).toBeInTheDocument();
  });

  it('records a typed reading as manual, never as logger', async () => {
    const record = vi.spyOn(api, 'recordTemperature').mockResolvedValue(reading());
    withToasts(<ColdChainCell shipment={shipment({})} onRecorded={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /record reading/i }));
    await userEvent.type(screen.getByLabelText(/temperature in °C/i), '5.5');
    await userEvent.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(record).toHaveBeenCalledWith('shp-1', 5.5, 'manual'));
  });

  it('reports an excursion as an alert rather than a success', async () => {
    vi.spyOn(api, 'recordTemperature').mockResolvedValue(reading({
      temp_c: 15, band_state: 'above', deviation_c: 7, breached: true, excursion: true,
      summary: '7 °C above the 2…8 °C band', excursion_count: 1,
    }));
    withToasts(<ColdChainCell shipment={shipment({})} onRecorded={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /record reading/i }));
    await userEvent.type(screen.getByLabelText(/temperature in °C/i), '15');
    await userEvent.click(screen.getByRole('button', { name: 'Log' }));

    expect(await screen.findByText(/7 °C above/)).toBeInTheDocument();
  });

  it('refuses a blank or non-numeric entry instead of sending it', async () => {
    const record = vi.spyOn(api, 'recordTemperature');
    withToasts(<ColdChainCell shipment={shipment({})} onRecorded={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /record reading/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Log' }));

    expect(record).not.toHaveBeenCalled();
    expect(await screen.findByText(/enter the temperature/i)).toBeInTheDocument();
  });

  it('does not claim a reading that is sitting in the offline queue', async () => {
    vi.spyOn(api, 'recordTemperature').mockResolvedValue(
      { queued: true, pending: true } as never);
    withToasts(<ColdChainCell shipment={shipment({})} onRecorded={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /record reading/i }));
    await userEvent.type(screen.getByLabelText(/temperature in °C/i), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Log' }));

    expect(await screen.findByText(/held on this console/i)).toBeInTheDocument();
  });
});
