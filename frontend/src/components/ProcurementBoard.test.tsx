import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { ProcurementBoard } from './ProcurementBoard';
import { ToastProvider } from './Toast';
import { api } from '@/lib/api';
import type { PurchaseOrder } from '@/lib/types';

/**
 * The board's job is to show the leg before the ship, and to make the
 * handover into a consignment a real one. Both are pinned here.
 */

const withToasts = (ui: React.ReactElement) => render(<ToastProvider>{ui}</ToastProvider>);

const order = (over: Partial<PurchaseOrder> = {}): PurchaseOrder => ({
  id: 'po-1', reference: 'PO-2026-AB12CD', vendor: 'Indian Oil Corporation',
  item_name: 'Aviation Turbine Fuel', category: 'fuel', quantity: 12000, unit: 'L',
  inventory_item_id: 'inv-avtur', destination_station: 'Maitri', status: 'confirmed',
  ordered_at: '2026-09-01T00:00:00.000Z', promised_at: '2026-09-20T00:00:00.000Z',
  shipment_id: null, notes: null,
  is_overdue: false, days_overdue: null, slip_warning: null,
  ...over,
});

const board = (onDispatched = vi.fn()) => withToasts(
  <ProcurementBoard stationId="Maitri" stationLabel="Maitri Base"
                    onDispatched={onDispatched} />,
);

beforeEach(() => { vi.restoreAllMocks(); });

describe('ProcurementBoard', () => {
  it('shows what the station has on order', async () => {
    vi.spyOn(api, 'listPurchaseOrders').mockResolvedValue([order()]);
    board();
    expect(await screen.findByText('Aviation Turbine Fuel')).toBeInTheDocument();
    expect(screen.getByText(/Indian Oil Corporation/)).toBeInTheDocument();
  });

  it('says plainly when nothing is on order', async () => {
    vi.spyOn(api, 'listPurchaseOrders').mockResolvedValue([]);
    board();
    expect(await screen.findByText(/nothing on order/i)).toBeInTheDocument();
  });

  it('calls out a vendor that has missed its date', async () => {
    /** The row this board exists for. */
    vi.spyOn(api, 'listPurchaseOrders').mockResolvedValue([order({
      is_overdue: true, days_overdue: 9,
      slip_warning: 'Indian Oil Corporation promised this 9 day(s) ago and it has '
        + 'not shipped. Chase it, or plan without it.',
    })]);
    board();
    expect(await screen.findByText(/promised this 9 day\(s\) ago/)).toBeInTheDocument();
    expect(screen.getByText(/1 vendor late/)).toBeInTheDocument();
  });

  it('leaves cancelled orders off the board', async () => {
    vi.spyOn(api, 'listPurchaseOrders').mockResolvedValue([
      order({ status: 'cancelled', item_name: 'Called Off Crate' }),
    ]);
    board();
    await waitFor(() => expect(screen.getByText(/nothing on order/i)).toBeInTheDocument());
  });

  it('offers confirmation only on an unacknowledged order', async () => {
    vi.spyOn(api, 'listPurchaseOrders').mockResolvedValue([order({ status: 'ordered' })]);
    board();
    expect(await screen.findByRole('button', { name: /vendor confirmed/i }))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dispatch/i })).not.toBeInTheDocument();
  });

  it('offers dispatch only once the vendor has confirmed', async () => {
    /** An order nobody has agreed to supply must not become a crate on the
     *  board. */
    vi.spyOn(api, 'listPurchaseOrders').mockResolvedValue([order({ status: 'confirmed' })]);
    board();
    expect(await screen.findByRole('button', { name: /dispatch as consignment/i }))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /vendor confirmed/i }))
      .not.toBeInTheDocument();
  });

  it('dispatching reports the crate it became and refreshes the cargo board', async () => {
    vi.spyOn(api, 'listPurchaseOrders').mockResolvedValue([order()]);
    vi.spyOn(window, 'prompt').mockReturnValue('8400');
    vi.spyOn(api, 'dispatchPurchaseOrder').mockResolvedValue({
      order: order({ status: 'shipped', shipment_id: 'shp-9' }),
      shipment: { barcode_id: 'SHP-2026-ABC123' } as never,
    });
    const onDispatched = vi.fn();
    board(onDispatched);

    await userEvent.click(
      await screen.findByRole('button', { name: /dispatch as consignment/i }));

    await waitFor(() => expect(api.dispatchPurchaseOrder)
      .toHaveBeenCalledWith('po-1', 8400));
    expect(await screen.findByText(/SHP-2026-ABC123/)).toBeInTheDocument();
    await waitFor(() => expect(onDispatched).toHaveBeenCalled());
  });

  it('refuses a weight that is not a number rather than sending it', async () => {
    /** Shipping weight feeds the risk model; a NaN would score silently. */
    vi.spyOn(api, 'listPurchaseOrders').mockResolvedValue([order()]);
    vi.spyOn(window, 'prompt').mockReturnValue('heavy');
    const dispatch = vi.spyOn(api, 'dispatchPurchaseOrder');
    board();

    await userEvent.click(
      await screen.findByRole('button', { name: /dispatch as consignment/i }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(await screen.findByText(/shipping weight in kilograms/i)).toBeInTheDocument();
  });

  it('does nothing when the weight prompt is dismissed', async () => {
    vi.spyOn(api, 'listPurchaseOrders').mockResolvedValue([order()]);
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    const dispatch = vi.spyOn(api, 'dispatchPurchaseOrder');
    board();

    await userEvent.click(
      await screen.findByRole('button', { name: /dispatch as consignment/i }));

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not claim a dispatch that is sitting in the offline queue', async () => {
    vi.spyOn(api, 'listPurchaseOrders').mockResolvedValue([order()]);
    vi.spyOn(window, 'prompt').mockReturnValue('8400');
    vi.spyOn(api, 'dispatchPurchaseOrder').mockResolvedValue(
      { queued: true, pending: true } as never);
    board();

    await userEvent.click(
      await screen.findByRole('button', { name: /dispatch as consignment/i }));

    expect(await screen.findByText(/held on this console/i)).toBeInTheDocument();
  });

  it('surfaces a refusal rather than failing silently', async () => {
    vi.spyOn(api, 'listPurchaseOrders').mockResolvedValue([order({ status: 'ordered' })]);
    vi.spyOn(api, 'updatePurchaseOrder')
      .mockRejectedValue(new Error('Station unreachable'));
    board();

    await userEvent.click(await screen.findByRole('button', { name: /vendor confirmed/i }));

    expect(await screen.findByText(/station unreachable/i)).toBeInTheDocument();
  });
});
