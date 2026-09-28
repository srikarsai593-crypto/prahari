import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useInventory, useStockCommand } from './useInventory';
import { api } from './api';
import type { InventoryItem, StockCommandResult } from './types';

/**
 * The inventory page's data layer, now testable because it is no longer
 * interleaved with six hundred lines of markup.
 */

let broadcast: { type: string; data?: unknown } | null = null;
vi.mock('@/components/WebSocketProvider', () => ({
  useWebSocket: () => ({ lastMessage: broadcast, connected: true, socket: null }),
}));

const fuel: InventoryItem = {
  id: 'inv-fuel', name: 'Diesel Fuel', category: 'consumable', station: 'Maitri',
  quantity: 6500, unit: 'L', base_burn_rate: 350, beta: 0.15, days_of_cover: 18.6,
  updated_at: '2026-09-27T10:00:00.000Z', stock_state: 'depleting',
};

const basis = { station: 'Maitri', headcount: 6, nominal_headcount: 6, factor: 1 };

beforeEach(() => {
  broadcast = null;
  vi.spyOn(api, 'listInventory').mockResolvedValue([fuel]);
  vi.spyOn(api, 'getHeadcountBasis').mockResolvedValue(basis);
});

describe('useInventory', () => {
  it('waits for the persisted station before fetching', () => {
    renderHook(() => useInventory('Maitri', false));
    // Fetching against a default station only to refetch against the real one
    // throws the first answer away and flashes the wrong base's stock.
    expect(api.listInventory).not.toHaveBeenCalled();
  });

  it('loads the stock and the basis it is scaled against together', async () => {
    const { result } = renderHook(() => useInventory('Maitri', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual([fuel]);
    expect(result.current.headcount).toEqual(basis);
  });

  it('keeps the last known figures when the station cannot be reached', async () => {
    const { result } = renderHook(() => useInventory('Maitri', true));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    vi.spyOn(api, 'listInventory').mockRejectedValue(new Error('Cannot reach the station'));
    await act(async () => { await result.current.reload(); });

    // A station that cannot be reached is not a station with no stock, and an
    // empty table says the second thing.
    expect(result.current.items).toEqual([fuel]);
    expect(result.current.error).toMatch(/cannot reach/i);
  });

  it('clears the error once the link comes back', async () => {
    const { result } = renderHook(() => useInventory('Maitri', true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.spyOn(api, 'listInventory').mockRejectedValueOnce(new Error('down'));
    await act(async () => { await result.current.reload(); });
    expect(result.current.error).not.toBeNull();

    vi.spyOn(api, 'listInventory').mockResolvedValue([fuel]);
    await act(async () => { await result.current.reload(); });
    expect(result.current.error).toBeNull();
  });

  it('refetches when the station switches', async () => {
    const { rerender } = renderHook(({ id }) => useInventory(id, true),
                                    { initialProps: { id: 'Maitri' } });
    await waitFor(() => expect(api.listInventory).toHaveBeenCalledWith({ station: 'Maitri' }));

    rerender({ id: 'Bharati' });
    await waitFor(() => expect(api.listInventory).toHaveBeenCalledWith({ station: 'Bharati' }));
  });

  it.each([
    'inventory_update', 'inventory_alert', 'blizzard_update', 'shipment_update',
    'personnel_update', 'station_reset',
  ])('refetches on a %s broadcast', async (type) => {
    const { rerender } = renderHook(() => useInventory('Maitri', true));
    await waitFor(() => expect(api.listInventory).toHaveBeenCalledTimes(1));

    broadcast = { type, data: {} };
    rerender();

    await waitFor(() => expect(api.listInventory).toHaveBeenCalledTimes(2));
  });

  it('ignores a broadcast that cannot have changed the stock', async () => {
    const { rerender } = renderHook(() => useInventory('Maitri', true));
    await waitFor(() => expect(api.listInventory).toHaveBeenCalledTimes(1));

    broadcast = { type: 'incident_sop_update', data: {} };
    rerender();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.listInventory).toHaveBeenCalledTimes(1);
  });

  it('refetches when the roster moves, because burn rate follows headcount', async () => {
    const { rerender } = renderHook(() => useInventory('Maitri', true));
    await waitFor(() => expect(api.getHeadcountBasis).toHaveBeenCalledTimes(1));

    broadcast = { type: 'personnel_update', data: { status: 'in_transit' } };
    rerender();

    await waitFor(() => expect(api.getHeadcountBasis).toHaveBeenCalledTimes(2));
  });
});

describe('useStockCommand', () => {
  const previewResult = (overrides: Partial<StockCommandResult> = {}): StockCommandResult => ({
    parsed: { action: 'decrement', quantity: 200, item: 'diesel fuel',
              location: 'Maitri', parse_source: 'fallback' },
    applied: false, dry_run: true, station: 'Maitri',
    item_id: 'inv-fuel', item_name: 'Diesel Fuel', unit: 'L',
    old_quantity: 6500, new_quantity: 6300,
    ...overrides,
  });

  it('refuses to run on an empty command', async () => {
    const { result } = renderHook(() => useStockCommand('Maitri', vi.fn()));
    const command = vi.spyOn(api, 'stockCommand');

    let outcome: { error?: string } = {};
    await act(async () => { outcome = await result.current.parse(); });

    expect(outcome.error).toMatch(/enter a stock command/i);
    expect(command).not.toHaveBeenCalled();
  });

  it('previews without writing', async () => {
    const command = vi.spyOn(api, 'stockCommand').mockResolvedValue(previewResult());
    const onApplied = vi.fn();
    const { result } = renderHook(() => useStockCommand('Maitri', onApplied));

    act(() => result.current.setTranscript('Removed 200 litres of diesel fuel'));
    await act(async () => { await result.current.parse(); });

    // dry_run true, and the page is not told to refetch — nothing changed.
    expect(command).toHaveBeenCalledWith('Removed 200 litres of diesel fuel', 'Maitri', true);
    expect(result.current.preview?.new_quantity).toBe(6300);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('will not offer a preview it never received', async () => {
    /**
     * The command is parsed on the server. With the link down the call is
     * queued and resolves to the queue marker, so setting that as the preview
     * put a confirm button in front of an operator with nothing behind it —
     * and the write would then apply on reconnect unread.
     */
    vi.spyOn(api, 'stockCommand').mockResolvedValue({ queued: true, pending: true } as never);
    const { result } = renderHook(() => useStockCommand('Maitri', vi.fn()));

    act(() => result.current.setTranscript('Removed 200 litres of diesel fuel'));
    let outcome: Awaited<ReturnType<typeof result.current.parse>> | undefined;
    await act(async () => { outcome = await result.current.parse(); });

    expect(outcome).toHaveProperty('error');
    expect(result.current.preview).toBeNull();
  });

  it('applies the same text it previewed', async () => {
    vi.spyOn(api, 'stockCommand')
      .mockResolvedValueOnce(previewResult())
      .mockResolvedValueOnce(previewResult({ applied: true, dry_run: false }));
    const onApplied = vi.fn();
    const { result } = renderHook(() => useStockCommand('Maitri', onApplied));

    act(() => result.current.setTranscript('Removed 200 litres of diesel fuel'));
    await act(async () => { await result.current.parse(); });
    await act(async () => { await result.current.apply(); });

    expect(api.stockCommand)
      .toHaveBeenLastCalledWith('Removed 200 litres of diesel fuel', 'Maitri', false);
    expect(onApplied).toHaveBeenCalled();
    expect(result.current.preview).toBeNull();
  });

  it('will not apply without a preview to apply', async () => {
    const command = vi.spyOn(api, 'stockCommand');
    const { result } = renderHook(() => useStockCommand('Maitri', vi.fn()));

    let outcome: { error?: string } = {};
    await act(async () => { outcome = await result.current.apply(); });

    expect(outcome.error).toBeDefined();
    expect(command).not.toHaveBeenCalled();
  });

  it('keeps the preview when the station refuses the write', async () => {
    vi.spyOn(api, 'stockCommand')
      .mockResolvedValueOnce(previewResult())
      .mockResolvedValueOnce(previewResult({ applied: false, error: 'Item not found' }));
    const { result } = renderHook(() => useStockCommand('Maitri', vi.fn()));

    act(() => result.current.setTranscript('Removed 200 litres of diesel fuel'));
    await act(async () => { await result.current.parse(); });
    await act(async () => { await result.current.apply(); });

    expect(result.current.preview?.error).toBe('Item not found');
    expect(result.current.transcript).not.toBe('');
  });

  it('rewrites an ambiguous command with the exact item', async () => {
    /**
     * The station returns every candidate; the page used to print them as a
     * dead end and leave the commander to retype the whole command.
     */
    vi.spyOn(api, 'stockCommand')
      .mockResolvedValueOnce(previewResult({
        item_id: undefined, item_name: undefined,
        ambiguous_matches: ['Aviation Turbine Fuel', 'Diesel Fuel'],
        error: '"fuel" matched 2 items at Maitri',
      }))
      .mockResolvedValueOnce(previewResult());
    const { result } = renderHook(() => useStockCommand('Maitri', vi.fn()));

    act(() => result.current.setTranscript('Removed 200 litres of fuel'));
    await act(async () => { await result.current.parse(); });
    await act(async () => { await result.current.disambiguate('Diesel Fuel'); });

    expect(api.stockCommand).toHaveBeenLastCalledWith('Removed 200 Diesel Fuel', 'Maitri', true);
    expect(result.current.transcript).toBe('Removed 200 Diesel Fuel');
  });

  it('preserves the direction when disambiguating an addition', async () => {
    vi.spyOn(api, 'stockCommand').mockResolvedValue(previewResult({
      parsed: { action: 'increment', quantity: 15, item: 'blankets',
                location: 'Maitri', parse_source: 'fallback' },
    }));
    const { result } = renderHook(() => useStockCommand('Maitri', vi.fn()));

    act(() => result.current.setTranscript('Added 15 blankets'));
    await act(async () => { await result.current.parse(); });
    await act(async () => { await result.current.disambiguate('Thermal Blankets'); });

    expect(api.stockCommand)
      .toHaveBeenLastCalledWith('Added 15 Thermal Blankets', 'Maitri', true);
  });

  it('drops a preview that named the previous station', async () => {
    vi.spyOn(api, 'stockCommand').mockResolvedValue(previewResult());
    const { result, rerender } = renderHook(({ id }) => useStockCommand(id, vi.fn()),
                                            { initialProps: { id: 'Maitri' } });

    act(() => result.current.setTranscript('Removed 200 litres of diesel fuel'));
    await act(async () => { await result.current.parse(); });
    expect(result.current.preview).not.toBeNull();

    rerender({ id: 'Bharati' });
    expect(result.current.preview).toBeNull();
  });

  it('discards a preview when the text is edited', async () => {
    vi.spyOn(api, 'stockCommand').mockResolvedValue(previewResult());
    const { result } = renderHook(() => useStockCommand('Maitri', vi.fn()));

    act(() => result.current.setTranscript('Removed 200 litres of diesel fuel'));
    await act(async () => { await result.current.parse(); });
    act(() => result.current.setTranscript('Removed 300 litres of diesel fuel'));

    // A preview describing text that is no longer on screen is worse than none.
    expect(result.current.preview).toBeNull();
  });

  it('reports a failure instead of leaving the button spinning', async () => {
    vi.spyOn(api, 'stockCommand').mockRejectedValue(new Error('Station refused'));
    const { result } = renderHook(() => useStockCommand('Maitri', vi.fn()));

    act(() => result.current.setTranscript('Removed 200 litres'));
    let outcome: { error?: string } = {};
    await act(async () => { outcome = await result.current.parse(); });

    expect(outcome.error).toBe('Station refused');
    expect(result.current.busy).toBe(false);
  });
});
