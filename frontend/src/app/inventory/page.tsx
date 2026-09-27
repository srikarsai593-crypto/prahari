'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Globe, Pencil, RotateCw, ShieldAlert, Terminal, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useWebSocket } from '@/components/WebSocketProvider';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';
import { useStation } from '@/components/StationProvider';
import { useStationConditions } from '@/lib/useStationConditions';
import {
  CrossStationDialog, HeadcountChip, ThermalLoadControl,
  STOCK_STATE_LABEL, STOCK_STATE_STYLE, STOCK_STATE_TEXT, stateOf,
} from '@/components/InventoryControls';
import type {
  InventoryItem, StockCommandResult, ExactCount, HeadcountBasis,
} from '@/lib/types';

const CATEGORIES = ['All', 'consumable', 'reusable'] as const;

export default function InventoryPage() {
  const { lastMessage } = useWebSocket();
  const { addToast } = useToast();
  // The console's active station is the only station this page reads or
  // writes. A second, page-local station filter could disagree with the header
  // badge, and a stock command applied against the wrong base is invisible.
  const { station, stationId, ready } = useStation();

  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('All');
  const [loading, setLoading] = useState(true);
  const [transcript, setTranscript] = useState('');
  const [parsing, setParsing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<StockCommandResult | null>(null);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [exactCount, setExactCount] = useState<ExactCount | null>(null);
  const [loadingExact, setLoadingExact] = useState(false);
  const [editQty, setEditQty] = useState<string | null>(null);
  const [savingQty, setSavingQty] = useState(false);
  /** What the station's consumable burn rates are currently scaled against. */
  const [headcount, setHeadcount] = useState<HeadcountBasis | null>(null);
  /** The item whose three-station comparison is open, if any. */
  const [comparing, setComparing] = useState<InventoryItem | null>(null);
  /** Per-item supply floor being edited in the detail panel. */
  const [policyDraft, setPolicyDraft] = useState<{ minimum: string; days: string } | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const { deltaT } = useStationConditions(stationId);

  const loadInventory = useCallback(async () => {
    setLoading(true);
    try {
      // The headcount basis is fetched alongside the rows because it is what
      // makes the days-of-cover figure traceable: a runway that halved because
      // eight people arrived reads very differently from one halved by weather.
      const [data, basis] = await Promise.allSettled([
        api.listInventory({ station: stationId }),
        api.getHeadcountBasis(stationId),
      ]);
      const items = data.status === 'fulfilled' && Array.isArray(data.value) ? data.value : [];
      setInventory(items);
      setHeadcount(basis.status === 'fulfilled' ? basis.value : null);
      setSelectedItem((prev) => (prev ? items.find((i) => i.id === prev.id) ?? null : null));
    } catch (e) {
      console.error('Failed to load inventory:', e);
    } finally {
      setLoading(false);
    }
  }, [stationId]);

  useEffect(() => { if (ready) void loadInventory(); }, [loadInventory, ready]);

  // Switching station invalidates anything that named the old one.
  useEffect(() => {
    setPreview(null); setEditQty(null); setPolicyDraft(null); setComparing(null);
  }, [stationId]);

  useEffect(() => {
    if (lastMessage && ['inventory_update', 'blizzard_update', 'shipment_update',
      'station_reset', 'inventory_alert', 'personnel_update'].includes(lastMessage.type)) {
      void loadInventory();
    }
  }, [lastMessage, loadInventory]);

  const visible = useMemo(
    () => (category === 'All' ? inventory : inventory.filter((i) => i.category === category)),
    [inventory, category],
  );

  // ── Stock command: parse, then confirm ──────────────────────────────────────
  /** Dry run — shows what the parser understood; writes nothing. */
  const handleParse = async () => {
    if (!transcript.trim()) return addToast('Enter a stock command first', 'warning');
    setParsing(true);
    setPreview(null);
    try {
      const res = await api.stockCommand(transcript, stationId, true);
      setPreview(res);
      if (res.error) addToast(res.error, 'warning');
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Stock command failed', 'alert');
    } finally { setParsing(false); }
  };

  /**
   * Resolve an ambiguous parse by naming the exact row.
   *
   * The backend already returns every candidate; the page used to print them
   * as a dead-end sentence and leave the commander to re-type the whole
   * command with more precise wording.
   */
  const handleDisambiguate = async (itemName: string) => {
    const parsed = preview?.parsed;
    const rewritten = parsed
      ? `${parsed.action === 'increment' ? 'Added' : 'Removed'} ${parsed.quantity} `
        + `${itemName}`
      : itemName;
    setTranscript(rewritten);
    setParsing(true);
    setPreview(null);
    try {
      const res = await api.stockCommand(rewritten, stationId, true);
      setPreview(res);
      if (res.error) addToast(res.error, 'warning');
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Stock command failed', 'alert');
    } finally { setParsing(false); }
  };

  /** Second pass against the same text — this one writes. */
  const handleApply = async () => {
    if (!preview || !transcript.trim()) return;
    setApplying(true);
    try {
      const res = await api.stockCommand(transcript, stationId, false);
      if (res.applied) {
        addToast(`${station.label} · ${res.item_name} → ${res.new_quantity} ${res.unit ?? ''}`
          , 'success');
        // A clamped decrement means the station was asked for stock it did not
        // have — that must not pass silently.
        if (res.warning) addToast(res.warning, 'warning');
        setTranscript('');
        setPreview(null);
      } else {
        addToast(res.error || 'Nothing here matches that item', 'warning');
        setPreview(res);
      }
      void loadInventory();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Stock command failed', 'alert');
    } finally { setApplying(false); }
  };

  // ── Manual quantity correction ─────────────────────────────────────────────
  const saveQuantity = async () => {
    if (!selectedItem || editQty === null) return;
    const qty = Number(editQty);
    if (!Number.isFinite(qty) || qty < 0) return addToast('Enter a quantity of 0 or more', 'warning');
    setSavingQty(true);
    try {
      // The active station goes with the write: the backend rejects an edit
      // aimed at another base's row with 403.
      await api.updateInventory(selectedItem.id, qty, stationId);
      addToast(`${selectedItem.name} set to ${qty} ${selectedItem.unit ?? ''}`, 'success');
      setEditQty(null);
      void loadInventory();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not update quantity', 'alert');
    } finally { setSavingQty(false); }
  };

  // ── Per-item supply floor ──────────────────────────────────────────────────
  const savePolicy = async () => {
    if (!selectedItem || !policyDraft) return;
    const minimum = policyDraft.minimum.trim();
    const days = policyDraft.days.trim();
    const minValue = minimum === '' ? null : Number(minimum);
    const daysValue = days === '' ? null : Number(days);
    if (minValue !== null && (!Number.isFinite(minValue) || minValue < 0)) {
      return addToast('Enter a minimum of 0 or more, or leave it blank', 'warning');
    }
    if (daysValue !== null && (!Number.isFinite(daysValue) || daysValue <= 0)) {
      return addToast('Enter a buffer of more than 0 days, or leave it blank', 'warning');
    }
    setSavingPolicy(true);
    try {
      await api.updateInventoryPolicy(selectedItem.id, {
        minimum_threshold: minValue ?? undefined,
        safety_stock_days: daysValue ?? undefined,
        // A PATCH treats an omitted field as "unchanged", so clearing a floor
        // has to be stated rather than implied by a blank box.
        clear_minimum: minValue === null,
        clear_safety_stock_days: daysValue === null,
        station: stationId,
      });
      addToast(`Supply policy saved for ${selectedItem.name}`, 'success');
      setPolicyDraft(null);
      void loadInventory();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not save the policy', 'alert');
    } finally { setSavingPolicy(false); }
  };

  // ── Deterministic count ────────────────────────────────────────────────────
  const countItem = selectedItem?.name ?? 'fuel';

  const handleExactCount = async () => {
    setLoadingExact(true);
    setExactCount(null);
    try {
      setExactCount(await api.getExactCount(stationId, countItem));
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Exact count query failed', 'alert');
    } finally { setLoadingExact(false); }
  };

  // A count for one item is meaningless next to a different item's row.
  useEffect(() => { setExactCount(null); }, [stationId, countItem]);

  /**
   * Colour by the row's own policy band rather than by one flat "< 15 days".
   *
   * The old rule put surgical consumables and spare bolts in the same band:
   * eighteen days of pharmaceuticals is an emergency because a medical flight
   * cannot land mid-winter, while eighteen days of diesel is an ordinary
   * interval between tanker runs.
   */
  const coverColour = (item: InventoryItem) => STOCK_STATE_TEXT[stateOf(item)];

  const parsed = preview?.parsed;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory & Life Support"
        code="INV-MNG-03"
        description="How much of everything the station is holding, how fast it is going, and
                     how many days are left at the current rate."
      >
        <button className="btn-secondary text-13" onClick={loadInventory}>
          <RotateCw size={14} aria-hidden="true" /> Refresh
        </button>
      </PageHeader>

      {/* ΔT drives the depletion formula this whole page is about, and it
          used to be reachable only from the Cargo module. */}
      <ThermalLoadControl
        stationId={stationId}
        stationLabel={station.label}
        deltaT={deltaT}
        onApplied={loadInventory}
      />

      {/* ── Stock command ─────────────────────────────────────────────────── */}
      <div className="subview-card rounded-2xl p-6">
        <h2 className="text-base font-bold text-arctic-900 mb-1 flex items-center gap-2">
          <Terminal size={16} className="text-arctic-600" aria-hidden="true" /> Stock Command
        </h2>
        <p className="text-xs text-frost-muted mb-1">
          Write the change the way you would say it — e.g. &quot;Removed 4 thermal blankets from
          Shed 2&quot; — and check it before it is applied.
        </p>
        <p className="text-xs font-mono font-bold text-arctic-800 mb-3">
          Applies to {station.label} stock only.
        </p>
        <div className="flex gap-3">
          <input
            type="text"
            placeholder="e.g. Removed 4 thermal blankets from Shed 2"
            value={transcript}
            onChange={(e) => { setTranscript(e.target.value); setPreview(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleParse(); } }}
            aria-label={`Stock command for ${station.label}`}
            className="flex-1"
          />
          <button className="btn-primary text-xs whitespace-nowrap" onClick={handleParse}
                  disabled={parsing || applying}>
            {parsing ? 'Checking…' : 'Preview'}
          </button>
        </div>

        {/* Parse preview — nothing is written until Apply. */}
        {preview && (
          <div className="mt-4 inset-panel p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <span className="overline block">Understood as — nothing changed yet</span>
                {preview.error ? (
                  <p className="text-13 text-emergency font-semibold mt-2">{preview.error}</p>
                ) : (
                  <p className="metric text-lg text-arctic-900 mt-1.5">
                    {parsed?.action === 'increment' ? 'Add' : 'Remove'} {parsed?.quantity}{' '}
                    {preview.unit ?? ''} · {preview.item_name} @ {preview.station}
                  </p>
                )}
                {preview.ambiguous_matches && (
                  <div className="mt-2.5">
                    <p className="text-xs text-frost-muted mb-1.5">
                      Ambiguous match for &quot;{parsed?.item}&quot;. Which item did you mean?
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {preview.ambiguous_matches.map((name) => (
                        <button
                          key={name}
                          type="button"
                          data-compact
                          disabled={parsing}
                          onClick={() => void handleDisambiguate(name)}
                          className="btn-secondary !min-h-0 !px-2.5 !py-1 text-2xs"
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <button type="button" data-compact aria-label="Discard preview"
                      onClick={() => setPreview(null)}
                      className="text-frost-muted hover:text-arctic-900 px-2 py-1 rounded-md
                                 hover:bg-white transition-colors">
                <X size={14} aria-hidden="true" />
              </button>
            </div>

            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 font-mono text-xs">
              {[
                ['Change', parsed ? (parsed.action === 'increment' ? 'Add' : 'Remove') : '—'],
                ['Quantity', parsed ? String(parsed.quantity) : '—'],
                ['Item', preview.item_name ?? parsed?.item ?? '—'],
                ['Station', preview.station ?? stationId],
              ].map(([label, value]) => (
                <div key={label} className="bg-white border border-frost-border rounded-md px-2.5 py-2">
                  <dt className="text-2xs uppercase tracking-caps text-frost-muted">{label}</dt>
                  <dd className="font-bold text-arctic-900 truncate mt-0.5">{value}</dd>
                </div>
              ))}
            </dl>

            {preview.old_quantity !== undefined && (
              <p className="mt-3 text-13 text-frost-muted">
                <span className="font-mono font-bold text-arctic-900">
                  {preview.old_quantity} → {preview.new_quantity} {preview.unit ?? ''}
                </span>{' '}
                at {preview.station}.
              </p>
            )}
            {preview.warning && (
              <p className="mt-2 text-xs text-alert font-semibold">{preview.warning}</p>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className="btn-secondary text-13"
                      onClick={() => setPreview(null)}>
                Discard
              </button>
              <button type="button" className="btn-primary text-13" onClick={handleApply}
                      disabled={applying || !preview.item_id}>
                {applying ? 'Applying…' : `Apply to ${station.label}`}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Exact Count Banner ────────────────────────────────────────────── */}
      <div className="subview-card rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-bold text-arctic-900 text-sm">
            Stock Check — <span className="capitalize">{countItem}</span> at {stationId}
          </h3>
          <p className="text-xs text-frost-muted mt-0.5">
            A straight count of what is on the shelf, never an estimate —
            {selectedItem ? ' counting the selected item.' : ' select a row to count a specific item.'}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {exactCount && (
            <span className="metric text-lg text-nominal bg-nominal-tint border border-nominal-edge
                             px-4 py-2 rounded-md whitespace-nowrap">
              {exactCount.quantity} {exactCount.unit}
              {exactCount.matched_rows > 1 && (
                <span className="text-2xs font-normal text-frost-muted ml-2">
                  ({exactCount.matched_rows} rows)
                </span>
              )}
            </span>
          )}
          <button className="btn-secondary text-xs" onClick={handleExactCount} disabled={loadingExact}>
            {loadingExact ? 'Counting…' : 'Count Stock'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Table */}
        <div className={`subview-card rounded-2xl p-6 ${selectedItem ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
          <div className="flex justify-between items-center mb-5 flex-wrap gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-bold text-arctic-900">
                Inventory Levels — {station.label}
              </h2>
              <HeadcountChip basis={headcount} />
            </div>
            <div className="flex items-center gap-3">
              {/* Category only. The station comes from the header switcher, so
                  the table can never disagree with the badge above it. */}
              <div className="flex gap-1 bg-arctic-50 p-1 rounded-xl border border-arctic-200"
                   role="group" aria-label="Filter by category">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    onClick={() => setCategory(c)}
                    aria-pressed={category === c}
                    className={`px-4 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${
                      category === c
                        ? 'bg-white text-arctic-800 shadow-xs border border-arctic-200'
                        : 'text-frost-muted hover:text-arctic-800'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <button className="btn-secondary text-xs" onClick={loadInventory}>
                <RotateCw size={14} aria-hidden="true" /> Refresh
              </button>
            </div>
          </div>

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-10 bg-arctic-50 rounded-xl animate-pulse" />)}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-arctic-100 text-frost-muted uppercase tracking-wider">
                    <th className="pb-3 font-semibold">Item</th>
                    <th className="pb-3 font-semibold">Category</th>
                    <th className="pb-3 font-semibold">Station</th>
                    <th className="pb-3 font-semibold">Quantity</th>
                    <th className="pb-3 font-semibold">Rate/day</th>
                    <th className="pb-3 font-semibold">Cover</th>
                    <th className="pb-3 font-semibold">Status</th>
                    <th className="pb-3 font-semibold sr-only">Other stations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-arctic-50">
                  {visible.length === 0 ? (
                    <tr><td colSpan={8} className="py-8 text-center text-frost-muted text-13">
                      No {category === 'All' ? '' : `${category} `}stock records at {station.label}.
                    </td></tr>
                  ) : visible.map((item) => (
                    <tr
                      key={item.id}
                      onClick={() => {
                        setEditQty(null);
                        setSelectedItem((prev) => (prev?.id === item.id ? null : item));
                      }}
                      className={`cursor-pointer transition-colors ${selectedItem?.id === item.id ? 'bg-arctic-50' : 'hover:bg-arctic-50/40'}`}
                    >
                      <td className="py-3 font-bold text-arctic-900">{item.name}</td>
                      <td className="py-3">
                        <span className={`px-2.5 py-1 rounded-full border text-2xs font-semibold ${item.category === 'consumable' ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-sky-50 border-sky-200 text-sky-700'}`}>
                          {item.category}
                        </span>
                      </td>
                      <td className="py-3 text-frost-muted">{item.station}</td>
                      <td className="py-3 metric text-arctic-800">{item.quantity} {item.unit}</td>
                      <td className="py-3 metric font-normal text-frost-muted">
                        {typeof item.depletion_rate === 'number' ? `${item.depletion_rate.toFixed(1)}` : '—'}
                      </td>
                      <td className="py-3">
                        {typeof item.days_of_cover === 'number' ? (
                          <span className={`font-bold ${coverColour(item)}`}>
                            {item.days_of_cover >= 9999 ? '∞' : `${item.days_of_cover.toFixed(1)}d`}
                          </span>
                        ) : <span className="text-frost-muted">n/a</span>}
                      </td>
                      <td className="py-3">
                        <span data-compact
                              className={`px-2 py-0.5 rounded-full border text-2xs font-semibold
                                          whitespace-nowrap
                                          ${STOCK_STATE_STYLE[stateOf(item)]}`}>
                          {STOCK_STATE_LABEL[stateOf(item)]}
                        </span>
                        {item.is_below_minimum && (
                          <span className="ml-1.5 inline-flex items-center gap-1 text-2xs
                                           font-semibold text-rose-700"
                                title={`Below the station's floor of ${item.minimum_threshold} `
                                  + `${item.unit ?? ''}`}>
                            <ShieldAlert size={11} aria-hidden="true" /> floor
                          </span>
                        )}
                      </td>
                      <td className="py-3 text-right">
                        <button
                          type="button"
                          data-compact
                          title={`Compare ${item.name} across all three stations`}
                          aria-label={`Compare ${item.name} across all three stations`}
                          onClick={(e) => { e.stopPropagation(); setComparing(item); }}
                          className="text-frost-muted hover:text-arctic-800 p-1 rounded-md
                                     hover:bg-white transition-colors"
                        >
                          <Globe size={13} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedItem && (
          <div className="subview-card rounded-2xl p-6">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-base font-bold text-arctic-900">Item Detail</h2>
              <button className="text-xs text-frost-muted hover:text-arctic-800 font-semibold px-2 py-1 rounded-lg hover:bg-arctic-50 transition-colors flex items-center gap-1"
                      onClick={() => { setSelectedItem(null); setEditQty(null); }}>
                <X size={12} aria-hidden="true" /> Close
              </button>
            </div>
            <div className="space-y-4 text-xs">
              <div>
                <span className="overline">Name</span>
                <p className="text-xl font-bold text-arctic-900 mt-0.5">{selectedItem.name}</p>
                <p className="text-xs text-frost-muted mt-0.5">{selectedItem.station}</p>
              </div>

              {/* Manual quantity correction — scoped to the active station. */}
              <div>
                <span className="overline">Quantity</span>
                {editQty === null ? (
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <p className="metric text-arctic-900">
                      {selectedItem.quantity} {selectedItem.unit}
                    </p>
                    <button type="button" data-compact
                            className="btn-secondary text-2xs !px-2.5 !py-1 !min-h-0"
                            onClick={() => setEditQty(String(selectedItem.quantity))}>
                      <Pencil size={12} aria-hidden="true" /> Edit
                    </button>
                  </div>
                ) : (
                  <div className="mt-1">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        step="any"
                        value={editQty}
                        autoFocus
                        aria-label={`New quantity for ${selectedItem.name} at ${selectedItem.station}`}
                        onChange={(e) => setEditQty(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void saveQuantity(); }
                          if (e.key === 'Escape') setEditQty(null);
                        }}
                        className="flex-1 !min-h-0 !py-1.5 font-mono"
                      />
                      <span className="text-xs text-frost-muted shrink-0">{selectedItem.unit}</span>
                    </div>
                    <div className="flex justify-end gap-2 mt-2">
                      <button type="button" data-compact
                              className="btn-secondary text-2xs !px-2.5 !py-1 !min-h-0"
                              onClick={() => setEditQty(null)}>
                        Cancel
                      </button>
                      <button type="button" data-compact disabled={savingQty}
                              className="btn-primary text-2xs !px-2.5 !py-1 !min-h-0"
                              onClick={saveQuantity}>
                        <Check size={12} aria-hidden="true" />
                        {savingQty ? 'Saving…' : `Save to ${selectedItem.station}`}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {[
                { label: 'Normal Use', val: selectedItem.base_burn_rate != null ? `${selectedItem.base_burn_rate} ${selectedItem.unit ?? ''} / day` : 'n/a' },
                { label: 'Crew Load',
                  val: selectedItem.headcount_factor != null
                    && selectedItem.effective_base_rate != null
                    ? `${selectedItem.effective_base_rate.toFixed(2)} ${selectedItem.unit ?? ''}`
                      + ` / day (${selectedItem.headcount_factor.toFixed(2)}× crew)`
                    : 'not crew-scaled' },
                { label: 'Cold Load', val: `ΔT +${selectedItem.delta_t ?? 0} °C` },
                { label: 'Using Now', val: typeof selectedItem.depletion_rate === 'number' ? `${selectedItem.depletion_rate.toFixed(2)} ${selectedItem.unit ?? ''} / day` : 'n/a' },
              ].map((row) => (
                <div key={row.label}>
                  <span className="overline">{row.label}</span>
                  <p className="metric text-arctic-900 mt-0.5">{row.val}</p>
                </div>
              ))}
              <div>
                <span className="overline">Days of Cover</span>
                <p className={`font-bold text-2xl mt-0.5 ${coverColour(selectedItem)}`}>
                  {typeof selectedItem.days_of_cover === 'number'
                    ? selectedItem.days_of_cover >= 9999 ? '∞ (no depletion)' : `${selectedItem.days_of_cover.toFixed(1)}d`
                    : 'n/a'}
                </p>
                <p className="text-2xs text-frost-muted mt-1">
                  Judged as{' '}
                  <span className="font-semibold">
                    {STOCK_STATE_LABEL[stateOf(selectedItem)].toLowerCase()}
                  </span>
                  {selectedItem.critical_days != null && (
                    <> — critical below {selectedItem.critical_days}d, depleting below{' '}
                      {selectedItem.warning_days}d
                      {selectedItem.risk_class && (
                        <> ({selectedItem.risk_class.replace('_', ' ')} policy)</>
                      )}.
                    </>
                  )}
                </p>
              </div>

              {/* ── Configurable floor ───────────────────────────────────── */}
              <div className="pt-3 border-t border-frost-border">
                <div className="flex items-center justify-between gap-2">
                  <span className="overline">Supply Floor</span>
                  {policyDraft === null && (
                    <button type="button" data-compact
                            className="btn-secondary text-2xs !px-2.5 !py-1 !min-h-0"
                            onClick={() => setPolicyDraft({
                              minimum: selectedItem.minimum_threshold != null
                                ? String(selectedItem.minimum_threshold) : '',
                              days: selectedItem.safety_stock_days != null
                                ? String(selectedItem.safety_stock_days) : '',
                            })}>
                      <Pencil size={12} aria-hidden="true" /> Configure
                    </button>
                  )}
                </div>

                {policyDraft === null ? (
                  <p className="text-2xs text-frost-muted mt-1 leading-relaxed">
                    {selectedItem.minimum_threshold != null
                      || selectedItem.safety_stock_days != null ? (
                        <>
                          {selectedItem.minimum_threshold != null && (
                            <>Alert below{' '}
                              <span className="font-mono font-bold text-arctic-900">
                                {selectedItem.minimum_threshold} {selectedItem.unit ?? ''}
                              </span>.{' '}
                            </>
                          )}
                          {selectedItem.safety_stock_days != null && (
                            <>Critical below{' '}
                              <span className="font-mono font-bold text-arctic-900">
                                {selectedItem.safety_stock_days} days
                              </span> of cover.
                            </>
                          )}
                        </>
                      ) : (
                        <>No station-specific floor set — judged on the{' '}
                          {selectedItem.risk_class?.replace('_', ' ') ?? 'default'} class
                          defaults above.</>
                      )}
                  </p>
                ) : (
                  <div className="mt-2 space-y-2">
                    <div>
                      <label htmlFor="inv-min" className="text-2xs">
                        Alert below ({selectedItem.unit ?? 'units'})
                      </label>
                      <input id="inv-min" type="number" min={0} step="any"
                             placeholder="e.g. 5000 — blank to clear"
                             value={policyDraft.minimum}
                             onChange={(e) => setPolicyDraft(
                               { ...policyDraft, minimum: e.target.value })}
                             className="!min-h-0 !py-1.5 font-mono" />
                    </div>
                    <div>
                      <label htmlFor="inv-days" className="text-2xs">
                        Critical below (days of cover)
                      </label>
                      <input id="inv-days" type="number" min={1} step="any"
                             placeholder={`class default ${selectedItem.critical_days ?? 15}`}
                             value={policyDraft.days}
                             onChange={(e) => setPolicyDraft(
                               { ...policyDraft, days: e.target.value })}
                             className="!min-h-0 !py-1.5 font-mono" />
                    </div>
                    <div className="flex justify-end gap-2">
                      <button type="button" data-compact
                              className="btn-secondary text-2xs !px-2.5 !py-1 !min-h-0"
                              onClick={() => setPolicyDraft(null)}>
                        Cancel
                      </button>
                      <button type="button" data-compact disabled={savingPolicy}
                              className="btn-primary text-2xs !px-2.5 !py-1 !min-h-0"
                              onClick={() => void savePolicy()}>
                        <Check size={12} aria-hidden="true" />
                        {savingPolicy ? 'Saving…' : 'Save Policy'}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-frost-border">
                <button type="button" className="btn-secondary text-2xs w-full !min-h-0 !py-1.5"
                        onClick={() => setComparing(selectedItem)}>
                  <Globe size={12} aria-hidden="true" /> Check other stations
                </button>
              </div>
            </div>
            <div className="mt-5 p-4 bg-arctic-50 rounded-xl border border-arctic-200">
              <p className="overline mb-1.5">How this is worked out</p>
              <p className="text-2xs text-arctic-800 leading-relaxed">
                Days left is what is on the shelf divided by how fast it is going. Cold weather
                pushes that rate up, so a blizzard shortens the cover on everything the station
                burns to stay warm.
              </p>
            </div>
          </div>
        )}
      </div>

      {comparing && (
        <CrossStationDialog
          itemName={comparing.name}
          homeStation={stationId}
          onClose={() => setComparing(null)}
        />
      )}
    </div>
  );
}
