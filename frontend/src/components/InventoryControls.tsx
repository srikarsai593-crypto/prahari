'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDialogFocus } from '@/lib/useDialogFocus';
import { CloudSnow, Users, X } from 'lucide-react';
import { api, isQueued, queuedMessage } from '@/lib/api';
import { useToast } from './Toast';
import { STATIONS } from '@/lib/stations';
import type {
  CrossStationStock, HeadcountBasis, InventoryItem, StockState,
} from '@/lib/types';

/**
 * Inventory-side controls for the depletion model and the multi-station claim.
 *
 * Three gaps these close:
 *  - ΔT could only be set from the Cargo module, so the page whose whole
 *    subject is the depletion formula was the one place you could not drive it;
 *  - the burn rate's headcount basis was invisible, so a runway that halved
 *    because eight people arrived looked identical to one halved by weather;
 *  - "unified logistics grid across three stations" had no view that showed
 *    an item at more than one station.
 */

// ── Stock-state presentation, shared by the table and the detail panel ──────
export const STOCK_STATE_STYLE: Record<StockState, string> = {
  critical: 'bg-rose-50 border-rose-200 text-rose-800',
  depleting: 'bg-amber-50 border-amber-200 text-amber-900',
  nominal: 'bg-emerald-50 border-emerald-200 text-emerald-800',
};

export const STOCK_STATE_TEXT: Record<StockState, string> = {
  critical: 'text-rose-700',
  depleting: 'text-amber-700',
  nominal: 'text-emerald-700',
};

export const STOCK_STATE_LABEL: Record<StockState, string> = {
  critical: 'Critical',
  depleting: 'Depleting',
  nominal: 'Nominal',
};

/** Falls back to the flat rule only for a row the backend has not classified. */
export const stateOf = (item: InventoryItem): StockState =>
  item.stock_state ?? (item.days_of_cover != null && item.days_of_cover < 15
    ? 'critical' : 'nominal');

// ── ΔT simulator ────────────────────────────────────────────────────────────
const PRESETS: Array<{ label: string; value: number }> = [
  { label: 'Calm 0°C', value: 0 },
  { label: 'Storm +15°C', value: 15 },
  { label: 'Whiteout +30°C', value: 30 },
];

interface WeatherProps {
  stationId: string;
  stationLabel: string;
  /** Live reading from the station, so the control cannot drift from the truth. */
  deltaT: number | null;
  onApplied: () => void;
}

export function ThermalLoadControl({ stationId, stationLabel, deltaT, onApplied }: WeatherProps) {
  const { addToast } = useToast();
  const [value, setValue] = useState(deltaT ?? 0);
  const [applying, setApplying] = useState(false);

  // Follow the station's own reading: another console (or the Cargo page)
  // setting ΔT must move this slider, not be silently overwritten by it.
  useEffect(() => { if (deltaT !== null) setValue(deltaT); }, [deltaT]);

  const apply = useCallback(async (next: number) => {
    setApplying(true);
    try {
      const res = await api.applyStationWeather(stationId, next);
      if (isQueued(res)) return addToast(queuedMessage('Blizzard load'), 'info');
      const degraded = res.degraded_expeditions ?? [];
      addToast(
        `${stationLabel} blizzard load ΔT +${next}°C — ${res.affected} consignment(s) re-scored, `
        + `${res.delayed} delayed`
        + (degraded.length ? `, ${degraded.length} traverse(s) no longer viable` : ''),
        res.delayed || degraded.length ? 'warning' : 'success');
      onApplied();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not apply the weather', 'alert');
    } finally { setApplying(false); }
  }, [stationId, stationLabel, addToast, onApplied]);

  const severity = value < 14 ? 'LOW' : value < 28 ? 'MODERATE' : 'SEVERE';
  const severityStyle = value < 14
    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
    : value < 28
      ? 'bg-amber-50 border-amber-200 text-amber-900'
      : 'bg-rose-50 border-rose-200 text-rose-800';

  return (
    <div className="subview-card rounded-2xl p-5">
      {/* h2: this is a top-level card on the inventory page, a sibling of
          "Inventory Levels" — not a subsection of anything. */}
      <h2 className="text-sm font-bold text-arctic-900 mb-1 flex items-center gap-2">
        <CloudSnow size={15} className="text-arctic-600" aria-hidden="true" />
        Blizzard Load
      </h2>
      <p className="text-2xs text-frost-muted mb-3">
        Colder weather means the station burns through supplies faster and cargo runs late.
        Setting the load here shortens every cover figure below and re-scores
        {' '}{stationLabel}&apos;s inbound crates.
      </p>

      <label htmlFor="inv-dt" className="overline">
        Blizzard load — ΔT +{value}°C
      </label>
      <input id="inv-dt" type="range" min={0} max={30} value={value}
             onChange={(e) => setValue(parseInt(e.target.value, 10))} />

      <div className="flex flex-wrap items-center gap-2 mt-3">
        {PRESETS.map((preset) => (
          <button key={preset.label} type="button" data-compact disabled={applying}
                  onClick={() => { setValue(preset.value); void apply(preset.value); }}
                  className="btn-secondary !min-h-0 !px-2.5 !py-1 text-2xs">
            {preset.label}
          </button>
        ))}
        <span data-compact
              className={`ml-auto px-2.5 py-1 rounded-full border text-2xs font-semibold
                          font-mono ${severityStyle}`}>
          {severity}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2 mt-3 pt-3
                      border-t border-frost-border">
        <span className="text-2xs font-mono text-frost-muted">
          On station: {deltaT === null ? 'no reading' : `ΔT +${deltaT.toFixed(1)}°C`}
        </span>
        <button type="button" className="btn-primary text-2xs !min-h-0 !px-3 !py-1.5"
                disabled={applying} onClick={() => void apply(value)}>
          {applying ? 'Applying…' : 'Apply to Station'}
        </button>
      </div>
    </div>
  );
}

// ── Headcount basis chip ────────────────────────────────────────────────────
/**
 * What the depletion rates below are scaled against.
 *
 * The multiplier is shown only when it is not 1 — at the station's nominal
 * headcount "1.00x baseline" is a number that says nothing happened, and it
 * was the loudest thing on the chip. When a traverse party arrives and the
 * rates really do move, that is exactly when the factor is worth reading.
 */
export function HeadcountChip({ basis }: { basis: HeadcountBasis | null }) {
  if (!basis) return null;
  const elevated = basis.factor > 1.01;
  const reduced = basis.factor < 0.99;
  const scaled = elevated || reduced;
  return (
    <span
      data-compact
      title={`Consumable and medical burn rates are scaled by live crew on station `
        + `(${basis.headcount}) against the station's nominal ${basis.nominal_headcount}.`}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-2xs
                  font-semibold font-mono ${elevated
                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                    : reduced
                      ? 'bg-sky-50 border-sky-200 text-sky-800'
                      : 'bg-arctic-50 border-arctic-200 text-arctic-700'}`}
    >
      <Users size={11} aria-hidden="true" />
      Rates assume {basis.headcount} crew on station
      {scaled && ` — ${basis.factor.toFixed(2)}× the usual`}
    </span>
  );
}

// ── Cross-station comparison ────────────────────────────────────────────────
interface CrossProps {
  itemName: string;
  homeStation: string;
  onClose: () => void;
}

const stationLabel = (id: string) => STATIONS.find((s) => s.id === id)?.label ?? id;

export function CrossStationDialog({ itemName, homeStation, onClose }: CrossProps) {
  const { addToast } = useToast();
  const [data, setData] = useState<CrossStationStock | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.crossStationStock(itemName)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((e) => {
        if (!cancelled) addToast(e instanceof Error ? e.message : 'Lookup failed', 'alert');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [itemName, addToast]);

  // Escape, a focus trap, and focus returned to whatever opened this.
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose);

  const mixedUnits = (data?.units.length ?? 0) > 1;

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[65] bg-arctic-950/30 backdrop-blur-sm flex items-center
                 justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Stock comparison for ${itemName}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="subview-card p-6 w-full max-w-lg shadow-raised">
        <div className="flex items-start justify-between gap-3 mb-4 pb-4
                        border-b border-frost-border">
          <div className="min-w-0">
            <span className="overline block">Polar Fleet Stock Comparison</span>
            <h2 className="text-lg font-bold text-arctic-900 mt-1 truncate">{itemName}</h2>
          </div>
          <button type="button" onClick={onClose} data-compact aria-label="Close"
                  className="text-frost-muted hover:text-arctic-900 px-2 py-1 rounded-md
                             hover:bg-frost-subtle transition-colors">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 bg-arctic-50 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : !data || data.items.length === 0 ? (
          <p className="text-13 text-frost-muted">
            No station holds anything matching &quot;{itemName}&quot;.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {data.items.map((item) => {
                const state = stateOf(item);
                const home = item.station === homeStation;
                return (
                  <div key={item.id}
                       className={`p-3 rounded-xl border flex items-center justify-between gap-3
                                   ${home ? 'bg-arctic-50 border-arctic-300'
                                          : 'bg-white border-frost-border'}`}>
                    <div className="min-w-0">
                      <div className="font-bold text-arctic-900 text-13 truncate">
                        {stationLabel(item.station)}
                        {home && (
                          <span className="ml-1.5 text-2xs font-normal text-frost-muted">
                            (this console)
                          </span>
                        )}
                      </div>
                      <div className="text-2xs text-frost-muted truncate">{item.name}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="metric text-arctic-900">
                        {item.quantity.toLocaleString()} {item.unit}
                      </div>
                      <div className={`text-2xs font-bold ${STOCK_STATE_TEXT[state]}`}>
                        {item.days_of_cover != null && item.days_of_cover < 9999
                          ? `${item.days_of_cover.toFixed(1)}d cover · `
                          : '∞ cover · '}
                        {STOCK_STATE_LABEL[state]}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {mixedUnits && (
              <p className="mt-3 text-2xs text-alert">
                These rows are counted in different units ({data.units.join(', ')}) — compare
                the cover figures, not the quantities.
              </p>
            )}

            {data.best_source && data.best_source !== homeStation && (
              <div className="mt-4 p-3 rounded-xl border border-sky-200 bg-sky-50/70">
                <p className="text-2xs text-sky-900 leading-relaxed">
                  <span className="font-bold">{stationLabel(data.best_source)}</span> holds the
                  deepest reserve. A transfer is raised as a consignment on the Cargo page with{' '}
                  <span className="font-mono">{stationLabel(data.best_source)}</span> as the
                  origin station — stock leaves that base when it is dispatched.
                </p>
              </div>
            )}
          </>
        )}

        <div className="flex justify-end mt-5">
          <button type="button" className="btn-secondary text-13" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
