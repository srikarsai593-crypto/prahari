'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, isQueued } from './api';
import { offlineQueue } from './offlineQueue';
import { useWebSocket } from '@/components/WebSocketProvider';
import { isAnyOf } from './broadcasts';
import type { HeadcountBasis, InventoryItem, StockCommandResult } from './types';

/**
 * The inventory page's data layer, lifted out of the component.
 *
 * The page had ten pieces of state and three fetch paths interleaved with six
 * hundred lines of markup, which made the two things it does — keeping a
 * station's stock on screen, and running a text command against it — impossible
 * to reason about separately or to test at all.
 */

/** What changes at a station that should pull the stock figures again. */
const STOCK_AFFECTING = [
  'inventory_update', 'inventory_alert', 'blizzard_update', 'shipment_update',
  // Consumable burn is scaled by who is actually on station, so the roster
  // moving changes the days-of-cover on this page.
  'personnel_update', 'station_reset',
] as const;

export function useInventory(stationId: string, ready: boolean) {
  const { lastMessage } = useWebSocket();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [headcount, setHeadcount] = useState<HeadcountBasis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // Fetched together because the headcount is what makes the days-of-cover
      // figure traceable: a runway that halved because eight people arrived
      // reads identically to one halved by a blizzard without it.
      const [stock, basis] = await Promise.allSettled([
        api.listInventory({ station: stationId }),
        api.getHeadcountBasis(stationId),
      ]);

      if (stock.status === 'fulfilled') {
        setItems(Array.isArray(stock.value) ? stock.value : []);
        setError(null);
      } else {
        // The last known figures stay on screen. A station that cannot be
        // reached is not a station with no stock, and blanking the table would
        // say the second thing.
        setError(stock.reason instanceof Error
          ? stock.reason.message
          : 'Could not reach the station records');
      }
      setHeadcount(basis.status === 'fulfilled' ? basis.value : null);
    } finally {
      setLoading(false);
    }
  }, [stationId]);

  useEffect(() => { if (ready) void reload(); }, [reload, ready]);

  useEffect(() => {
    if (isAnyOf(lastMessage, ...STOCK_AFFECTING)) void reload();
  }, [lastMessage, reload]);

  return { items, headcount, loading, error, reload };
}

export type StockCommandStage = 'idle' | 'parsing' | 'applying';

/**
 * The parse-preview-apply cycle for a typed stock command.
 *
 * Two passes over the same text by design: the first shows what the station
 * understood and writes nothing, the second commits it. A single-pass command
 * that both interprets and applies gives an operator no point at which to
 * notice it understood the wrong item.
 */
export function useStockCommand(stationId: string, onApplied: () => void) {
  const [transcript, setTranscript] = useState('');
  const [preview, setPreview] = useState<StockCommandResult | null>(null);
  const [stage, setStage] = useState<StockCommandStage>('idle');

  const reset = useCallback(() => { setPreview(null); setTranscript(''); }, []);

  // Switching station invalidates a preview that named the old one.
  useEffect(() => { setPreview(null); }, [stationId]);

  const parse = useCallback(async (text?: string) => {
    const source = (text ?? transcript).trim();
    if (!source) return { error: 'Enter a stock command first' } as const;
    if (text !== undefined) setTranscript(text);
    setStage('parsing');
    setPreview(null);
    try {
      const result = await api.stockCommand(source, stationId, true);
      // The command is parsed on the server, so with the link down there is
      // nothing to show. Previewing a write is also the one step that must not
      // be queued: it would apply on reconnect without anyone having read it.
      if (isQueued(result)) {
        return { error: 'The link is down, so this command cannot be checked. '
                        + 'Adjust the quantity directly, or wait for the link.' } as const;
      }
      setPreview(result);
      return { result } as const;
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : 'Stock command failed' } as const;
    } finally {
      setStage('idle');
    }
  }, [transcript, stationId]);

  const apply = useCallback(async () => {
    if (!preview || !transcript.trim()) return { error: 'Nothing to apply' } as const;
    setStage('applying');
    try {
      const result = await api.stockCommand(transcript, stationId, false);
      if (isQueued(result)) {
        reset();
        onApplied();
        return { queued: true } as const;
      }
      if (result.applied) reset();
      else setPreview(result);
      onApplied();
      return { result } as const;
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : 'Stock command failed' } as const;
    } finally {
      setStage('idle');
    }
  }, [preview, transcript, stationId, onApplied, reset]);

  /**
   * Resolve an ambiguous parse by naming the exact row.
   *
   * The station returns every candidate; the page used to print them as a
   * dead-end sentence and leave the commander to retype the whole command
   * with more precise wording.
   */
  const disambiguate = useCallback((itemName: string) => {
    const parsed = preview?.parsed;
    const rewritten = parsed
      ? `${parsed.action === 'increment' ? 'Added' : 'Removed'} ${parsed.quantity} ${itemName}`
      : itemName;
    return parse(rewritten);
  }, [preview, parse]);

  return {
    transcript,
    setTranscript: (value: string) => { setTranscript(value); setPreview(null); },
    preview,
    discard: () => setPreview(null),
    parse,
    apply,
    disambiguate,
    reset,
    parsing: stage === 'parsing',
    applying: stage === 'applying',
    busy: stage !== 'idle',
  };
}
