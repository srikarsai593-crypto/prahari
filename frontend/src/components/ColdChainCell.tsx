'use client';

import { useState } from 'react';
import { Thermometer, TriangleAlert } from 'lucide-react';
import { api, isQueued, queuedMessage } from '@/lib/api';
import { useToast } from '@/components/Toast';
import type { ColdChain, Shipment } from '@/lib/types';

/**
 * Cold-chain state for one consignment, and the way to record a reading.
 *
 * Most cargo has no temperature it must be kept at, so most rows render
 * nothing at all here — a board that showed "no reading" against every crate
 * of spares would bury the handful that matter.
 *
 * Two things this deliberately does not do. It does not present the current
 * reading alone: a crate that went to 15 °C and came back reads as fine that
 * way, and the excursion is the thing an operator needs on arrival. And it
 * never hides where a figure came from — Prahari has no sensors, so a reading
 * is either a gauge someone read or a logger that was downloaded.
 */

const STATE_STYLE: Record<ColdChain['state'], string> = {
  unmonitored: '',
  awaiting_reading: 'border-frost-border bg-frost-subtle text-frost-muted',
  within: 'border-nominal-edge bg-nominal-tint text-nominal',
  out_of_band: 'border-emergency-edge bg-emergency-tint text-emergency',
};

const STATE_LABEL: Record<ColdChain['state'], string> = {
  unmonitored: '',
  awaiting_reading: 'No reading',
  within: 'In band',
  out_of_band: 'Out of band',
};

export function ColdChainCell({ shipment, onRecorded }: {
  shipment: Shipment;
  onRecorded: () => void;
}) {
  const { addToast } = useToast();
  const [entering, setEntering] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const cold = shipment.cold_chain;

  if (!cold?.monitored) return <span className="text-frost-muted text-2xs">—</span>;

  const submit = async () => {
    const tempC = Number(value);
    if (value.trim() === '' || Number.isNaN(tempC)) {
      return addToast('Enter the temperature in °C', 'warning');
    }
    setSaving(true);
    try {
      // Recorded as 'manual' because that is what it is: someone typed it.
      const result = await api.recordTemperature(shipment.id, tempC, 'manual');
      if (isQueued(result)) {
        addToast(queuedMessage('Temperature reading'), 'info');
      } else {
        addToast(
          result.excursion
            ? `${shipment.barcode_id}: ${result.temp_c}°C — ${result.summary}`
            : `${shipment.barcode_id}: ${result.temp_c}°C, within band`,
          result.excursion ? 'alert' : 'success');
      }
      setValue('');
      setEntering(false);
      onRecorded();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not record the reading', 'alert');
    } finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col gap-1 items-start">
      <span data-compact
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border
                        text-2xs font-semibold ${STATE_STYLE[cold.state]}`}>
        <Thermometer size={11} aria-hidden="true" />
        {cold.last_temp_c != null ? `${cold.last_temp_c}°C` : STATE_LABEL[cold.state]}
      </span>

      <span className="text-2xs text-frost-muted font-mono">
        {cold.temp_min}…{cold.temp_max}°C
        {cold.last_temp_source && ` · ${cold.last_temp_source}`}
      </span>

      {/* Carried forward on purpose: the current reading alone would report a
          crate that spent six hours at 15 °C as perfectly fine. */}
      {cold.excursion_count > 0 && (
        <span className="inline-flex items-center gap-1 text-2xs font-semibold text-emergency">
          <TriangleAlert size={11} aria-hidden="true" />
          {cold.breach_summary}
        </span>
      )}

      {entering ? (
        <div className="flex items-center gap-1">
          <input
            type="number" step="0.1" autoFocus value={value}
            aria-label={`Temperature in °C for ${shipment.barcode_id}`}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            className="w-20 !py-1 !text-xs !min-h-0"
          />
          <button type="button" data-compact disabled={saving}
                  onClick={() => void submit()}
                  className="btn-secondary !min-h-0 !px-2 !py-1 text-2xs">
            {saving ? '…' : 'Log'}
          </button>
        </div>
      ) : (
        <button type="button" data-compact onClick={() => setEntering(true)}
                className="text-2xs text-arctic-700 hover:text-arctic-900 underline
                           underline-offset-2">
          Record reading
        </button>
      )}
    </div>
  );
}
