'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Wand2, ClipboardCheck, Play, CheckCircle2, XCircle, Users, UserPlus, X,
  Timer, TrendingDown, Truck,
} from 'lucide-react';
import { api, isQueued, queuedMessage } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';
import { ReadinessBreakdown } from '@/components/ReadinessBreakdown';
import { useStation } from '@/components/StationProvider';
import { useWebSocket } from '@/components/WebSocketProvider';
import { STATIONS } from '@/lib/stations';
import type {
  Expedition, ExpeditionInput, ExpeditionStatus, FeasibilityResult, FeasibilityLineItem,
  Personnel, ResupplyRecommendation,
} from '@/lib/types';

/**
 * An inbound consignment that would close a shortfall.
 *
 * The readiness check used to end at "Diesel Fuel short at Maitri: need 8000,
 * have 4500" and leave the commander to go and hunt through the Cargo page for
 * a tanker. The shipments table already knows what is coming and when.
 */
function ResupplyPanel({ resupply }: { resupply: ResupplyRecommendation }) {
  const hours = resupply.eta_hours;
  return (
    <div className="mt-2 p-3 rounded-lg border border-sky-200 bg-sky-50/80">
      <p className="flex items-start gap-2 text-2xs font-bold text-sky-900">
        <Truck size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
        Inbound resupply may cover this
      </p>
      <p className="text-2xs text-sky-900 mt-1 leading-relaxed">
        {resupply.recommendation_text}
      </p>
      <dl className="grid grid-cols-3 gap-2 mt-2 font-mono text-2xs">
        {[
          ['Consignment', resupply.barcode_id],
          ['Carrying', resupply.quantity != null
            ? `${resupply.quantity.toLocaleString()} ${resupply.unit ?? ''}`.trim() : 'unstated'],
          ['ETA', hours != null && hours > 0 ? `~${hours}h` : 'imminent'],
        ].map(([label, value]) => (
          <div key={label} className="bg-white border border-sky-200 rounded-md px-2 py-1.5">
            <dt className="text-2xs uppercase tracking-caps text-frost-muted">{label}</dt>
            <dd className="font-bold text-arctic-900 truncate mt-0.5">{value}</dd>
          </div>
        ))}
      </dl>
      {hours != null && hours > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-2xs text-sky-900">
          <Timer size={11} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Recommended action: hold the departure until{' '}
            <span className="font-mono font-bold">
              {resupply.eta
                ? `${new Date(resupply.eta).toLocaleString('en-GB', {
                  hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short',
                  timeZone: 'UTC',
                })} UTC`
                : `+${hours}h`}
            </span>
            {resupply.covers_shortfall
              ? ' and load from the inbound cargo.'
              : ' and re-score — it closes only part of the gap.'}
          </span>
        </p>
      )}
    </div>
  );
}

/** Statuses from which someone can still be put on a traverse. */
const ASSIGNABLE = new Set(['at_station', 'returned']);

/**
 * What an operator can do to an expedition in each state.
 *
 * Authorising is not a label change: it commits the named crew to the field
 * and draws the traverse's fuel out of station stock. Closing it brings the
 * crew back and releases them for reassignment.
 */
const NEXT_ACTIONS: Record<string, Array<{
  to: ExpeditionStatus; label: string; tone: 'primary' | 'secondary' | 'danger';
}>> = {
  draft: [
    { to: 'active', label: 'Authorise', tone: 'primary' },
    { to: 'cancelled', label: 'Call off', tone: 'danger' },
  ],
  active: [
    { to: 'completed', label: 'Complete', tone: 'primary' },
    { to: 'cancelled', label: 'Call off', tone: 'danger' },
  ],
  completed: [],
  cancelled: [],
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'planning',
  active: 'under way',
  completed: 'completed',
  cancelled: 'called off',
};

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-frost-subtle border-frost-border text-frost-muted',
  active: 'bg-nominal-tint border-nominal-edge text-nominal',
  completed: 'bg-arctic-100 border-arctic-200 text-arctic-800',
  cancelled: 'bg-emergency-tint border-emergency-edge text-emergency',
};

function LoadingCard() {
  return (
    <div className="subview-card rounded-2xl p-7 animate-pulse">
      <div className="h-4 bg-arctic-100 rounded w-1/2 mb-3" />
      <div className="h-3 bg-arctic-50 rounded w-full mb-2" />
      <div className="h-3 bg-arctic-50 rounded w-4/5" />
    </div>
  );
}

const initials = (name: string) =>
  name.split(' ').map((n) => n[0] || '').join('').slice(0, 2).toUpperCase();

export default function ExpeditionPage() {
  const { addToast } = useToast();
  const { station, stationId, ready } = useStation();
  const { lastMessage } = useWebSocket();

  const [nlText, setNlText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftedFromText, setDraftedFromText] = useState(false);
  const [expeditions, setExpeditions] = useState<Expedition[]>([]);
  const [roster, setRoster] = useState<Personnel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [crewEditFor, setCrewEditFor] = useState<string | null>(null);
  const [rescoringId, setRescoringId] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: '',
    station: stationId,
    start_date: '',
    end_date: '',
    personnel_required: 0,
    fuel_required_l: 0,
    raw_request: '',
  });
  /** Who the planner has picked for the traverse being written. */
  const [selectedCrew, setSelectedCrew] = useState<string[]>([]);
  const [feasibility, setFeasibility] = useState<FeasibilityResult | null>(null);
  const [showFeasibility, setShowFeasibility] = useState(false);
  const feasibilityOk = feasibility?.items?.every((item) => item.ok) ?? false;

  const load = useCallback(async () => {
    setLoading(true);
    const [exp, people] = await Promise.allSettled([
      api.listExpeditions({ station: stationId }),
      api.listPersonnel(stationId),
    ]);
    if (exp.status === 'fulfilled') setExpeditions(Array.isArray(exp.value) ? exp.value : []);
    if (people.status === 'fulfilled') setRoster(Array.isArray(people.value) ? people.value : []);
    setLoading(false);
  }, [stationId]);

  useEffect(() => { if (ready) void load(); }, [load, ready]);

  useEffect(() => {
    if (ready) {
      setForm((prev) => ({ ...prev, station: stationId }));
      setSelectedCrew([]);
    }
  }, [stationId, ready]);

  useEffect(() => {
    if (!lastMessage) return;
    if (['expedition_update', 'personnel_update', 'station_reset', 'inventory_update',
      'blizzard_update', 'shipment_update'].includes(lastMessage.type)) {
      void load();
    }
    // The closed-loop monitor announces a traverse that is no longer viable.
    // Without this the card would keep reporting the score it was approved
    // against until somebody happened to reload the page.
    if (lastMessage.type === 'expedition_readiness') {
      const degraded = lastMessage.data?.degraded ?? [];
      degraded.forEach((entry: { name: string; baseline_readiness: number;
                                 live_readiness: number }) => {
        addToast(`Attention: "${entry.name}" is no longer resource-viable — readiness `
          + `${entry.baseline_readiness}% → ${entry.live_readiness}%`, 'alert');
      });
      void load();
    }
    if (lastMessage.type === 'cascade_alert' && lastMessage.data?.summary) {
      addToast(lastMessage.data.summary, 'alert');
      void load();
    }
  }, [lastMessage, load, addToast]);

  /**
   * Re-score a traverse against live conditions and adopt the result as its
   * new baseline — the operator saying "I have seen the new numbers", which is
   * what stops the degradation alarm re-firing for ever.
   */
  const handleRescore = async (exp: Expedition) => {
    setRescoringId(exp.id);
    try {
      const res = await api.rescoreExpedition(exp.id);
      if (isQueued(res)) return addToast(queuedMessage('Re-score'), 'info');
      const short = res.feasibility?.items?.filter((i) => !i.ok).map((i) => i.label) ?? [];
      addToast(short.length === 0
        ? `${exp.name} re-scored — ${res.feasibility.readiness_score}% ready`
        : `${exp.name} re-scored at ${res.feasibility.readiness_score}% — `
          + `${short.join(', ')} still short`,
        short.length === 0 ? 'success' : 'warning');
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not re-score the traverse', 'alert');
    } finally { setRescoringId(null); }
  };

  /** People at this station not already committed to another traverse. */
  const available = useMemo(
    () => roster.filter((p) => ASSIGNABLE.has(p.status) && !p.expedition_id),
    [roster]);

  const toggleCrew = (id: string) => {
    setSelectedCrew((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      // The headcount follows the people actually picked, so the two cannot
      // disagree at the point of authorisation.
      setForm((f) => ({ ...f, personnel_required: next.length || f.personnel_required }));
      return next;
    });
  };

  // ── Draft from a written request ───────────────────────────────────────────
  const handleDraft = async () => {
    if (!nlText.trim()) return;
    setDrafting(true);
    try {
      const res = await api.parseNL(nlText);
      setForm((prev) => ({
        ...prev,
        name: res.name || prev.name,
        station: STATIONS.some((s) => s.id === res.station) ? res.station : prev.station,
        start_date: res.start_date ?? '',
        end_date: res.end_date ?? '',
        personnel_required: res.personnel_required ?? 0,
        fuel_required_l: res.fuel_required_l ?? 0,
        raw_request: nlText,
      }));
      setDraftedFromText(true);
      addToast('Draft filled in below — check the figures and pick the crew before saving',
        'info');
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not read that request', 'alert');
    } finally { setDrafting(false); }
  };

  // ── Readiness ──────────────────────────────────────────────────────────────
  const handleCheck = async () => {
    setChecking(true);
    try {
      const res = await api.checkFeasibility({
        station: form.station,
        personnel_required: form.personnel_required,
        fuel_required_l: form.fuel_required_l,
      });
      setFeasibility(res);
      setShowFeasibility(true);
      const short = res.items.filter((i) => !i.ok).map((i) => i.label);
      addToast(short.length === 0
        ? `${form.station} can support this — ${res.readiness_score}% ready`
        : `${short.join(', ')} short at ${form.station} — ${res.readiness_score}% ready`,
        short.length === 0 ? 'success' : 'warning');
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Readiness check failed', 'alert');
    } finally { setChecking(false); }
  };

  const handleSave = async () => {
    if (!form.name.trim()) return addToast('Give the expedition a name', 'warning');
    setSaving(true);
    try {
      const payload: ExpeditionInput = { ...form, crew_ids: selectedCrew };
      if (feasibility) {
        payload.readiness_score = feasibility.readiness_score;
        payload.readiness_breakdown = feasibility.readiness_breakdown;
      }
      await api.createExpedition(payload);
      addToast(selectedCrew.length > 0
        ? `${form.name} saved with ${selectedCrew.length} crew — authorise it when you are ready`
        : `${form.name} saved. Add crew before it can be authorised.`,
        selectedCrew.length > 0 ? 'success' : 'warning');
      setForm({
        name: '', station: stationId, start_date: '', end_date: '',
        personnel_required: 0, fuel_required_l: 0, raw_request: '',
      });
      setSelectedCrew([]);
      setNlText('');
      setDraftedFromText(false);
      setFeasibility(null);
      setShowFeasibility(false);
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not save the expedition', 'alert');
    } finally { setSaving(false); }
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  const handleTransition = async (exp: Expedition, to: ExpeditionStatus) => {
    if (to === 'cancelled' && !window.confirm(
      `Call off "${exp.name}"?\n\n`
      + 'The crew are released and any fuel already drawn goes back into store.')) return;
    setBusyId(exp.id);
    try {
      const updated = await api.updateExpeditionStatus(exp.id, to);
      if (isQueued(updated)) return addToast(queuedMessage('Status change'), 'info');
      const notes = updated.notes?.length ? ` — ${updated.notes.join('; ')}` : '';
      addToast(`${exp.name} ${STATUS_LABEL[updated.status] ?? updated.status}${notes}`,
        to === 'cancelled' ? 'warning' : 'success');
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not update the expedition', 'alert');
    } finally { setBusyId(null); }
  };

  /** Change the roster on a traverse that has not departed. */
  const updateCrew = async (exp: Expedition, personId: string, add: boolean) => {
    const current = (exp.crew ?? []).map((c) => c.id);
    const next = add ? [...current, personId] : current.filter((id) => id !== personId);
    setBusyId(exp.id);
    try {
      await api.setExpeditionCrew(exp.id, next);
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not change the crew', 'alert');
    } finally { setBusyId(null); }
  };

  return (
    <div>
      <PageHeader
        title="Expedition & Traverse"
        code="EXP-PLN-01"
        description="Plan a traverse, name the crew going on it, and check the station can support
                     it before you authorise the departure."
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Planner ──────────────────────────────────────────────────────── */}
        <div className="subview-card rounded-2xl p-7 lg:col-span-2 space-y-6">
          <div>
            <h2 className="text-lg font-bold text-arctic-900 mb-1 flex items-center gap-2">
              <Wand2 size={18} className="text-arctic-600" aria-hidden="true" />
              Start From a Written Request
            </h2>
            <p className="text-xs text-frost-muted mb-3">
              Describe the traverse the way a commander would. Prahari fills in the form below;
              check every figure before saving.
            </p>
            <textarea
              className="font-mono !text-13 resize-none"
              rows={3}
              placeholder="e.g. Schedule a geological survey to Schirmacher Oasis with 4 scientists for two weeks…"
              value={nlText}
              onChange={(e) => setNlText(e.target.value)}
            />
            {draftedFromText && (
              <p className="mt-2 text-2xs text-frost-muted">
                Filled in from your description — these are suggestions, not a plan. Confirm the
                dates, crew and fuel below.
              </p>
            )}
            <div className="mt-3">
              <button className="btn-secondary text-xs" onClick={handleDraft} disabled={drafting}>
                <Wand2 size={14} aria-hidden="true" />
                {drafting ? 'Reading…' : 'Fill in the form'}
              </button>
            </div>
          </div>

          {/* ── Details ────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-5 border-t border-arctic-100">
            <div>
              <label htmlFor="ex-name">Expedition Name</label>
              <input id="ex-name" type="text" placeholder="GLACIER-PULSE-IX" value={form.name}
                     onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="ex-station">Departing From</label>
              <select id="ex-station" value={form.station}
                      onChange={(e) => setForm({ ...form, station: e.target.value })}>
                {STATIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="ex-start">Start Date</label>
              <input id="ex-start" type="date" value={form.start_date}
                     onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            </div>
            <div>
              <label htmlFor="ex-end">End Date</label>
              <input id="ex-end" type="date" value={form.end_date}
                     onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
            </div>
            <div>
              <label htmlFor="ex-crew">Crew Needed</label>
              <input id="ex-crew" type="number" placeholder="4" min="0"
                     value={form.personnel_required || ''}
                     onChange={(e) => setForm({
                       ...form, personnel_required: parseInt(e.target.value, 10) || 0 })} />
              <p className="text-2xs text-frost-muted mt-1">
                {selectedCrew.length} picked below.
              </p>
            </div>
            <div>
              <label htmlFor="ex-fuel">Fuel Needed (L)</label>
              <input id="ex-fuel" type="number" placeholder="300" min="0"
                     value={form.fuel_required_l || ''}
                     onChange={(e) => setForm({
                       ...form, fuel_required_l: parseFloat(e.target.value) || 0 })} />
              <p className="text-2xs text-frost-muted mt-1">
                Leaves the store when the traverse is authorised.
              </p>
            </div>
          </div>

          {/* ── Crew picker ────────────────────────────────────────────────── */}
          <div className="pt-5 border-t border-arctic-100">
            <h3 className="text-sm font-bold text-arctic-900 mb-1 flex items-center gap-2">
              <Users size={16} className="text-arctic-600" aria-hidden="true" />
              Who Is Going
              <span className="font-normal text-frost-muted text-xs">
                {selectedCrew.length} of {form.personnel_required || 0} picked
              </span>
            </h3>
            <p className="text-xs text-frost-muted mb-3">
              Only crew at {station.label} who are not already on another traverse. They are
              committed as soon as you save, and return to the roster when the expedition closes.
            </p>

            {available.length === 0 ? (
              <p className="inset-panel p-3 text-xs text-frost-muted">
                Nobody at {station.label} is free right now — everyone is either out in the field
                or already assigned to another traverse.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {available.map((p) => {
                  const picked = selectedCrew.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggleCrew(p.id)}
                      aria-pressed={picked}
                      className={`flex items-center gap-3 p-2.5 rounded-xl border text-left
                                  transition-colors ${picked
                                    ? 'bg-arctic-50 border-arctic-400'
                                    : 'bg-white border-frost-border hover:border-arctic-300'}`}
                    >
                      <span className={`w-8 h-8 rounded-full flex items-center justify-center
                                        text-2xs font-bold shrink-0 border ${picked
                                          ? 'bg-arctic-600 text-white border-arctic-600'
                                          : 'bg-arctic-50 text-arctic-700 border-arctic-200'}`}>
                        {picked ? <CheckCircle2 size={14} aria-hidden="true" /> : initials(p.name)}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-13 font-semibold text-arctic-900 truncate">
                          {p.name}
                        </span>
                        <span className="block text-2xs text-frost-muted truncate">{p.role}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Readiness result ───────────────────────────────────────────── */}
          {showFeasibility && feasibility && (
            <div className={`p-4 rounded-xl border text-xs ${feasibilityOk
              ? 'border-emerald-200 bg-emerald-50/70' : 'border-rose-200 bg-rose-50/70'}`}>
              <div className={`font-bold text-xs mb-1 flex items-center gap-2 ${feasibilityOk
                ? 'text-emerald-800' : 'text-rose-800'}`}>
                <span className={`w-2 h-2 rounded-full ${feasibilityOk
                  ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                {feasibilityOk
                  ? `${form.station} can support this — ${feasibility.readiness_score}% ready`
                  : `Not enough to go on — ${feasibility.readiness_score}% ready`}
              </div>
              {feasibility.items?.map((item: FeasibilityLineItem) => (
                <div key={item.label}
                     className="mt-2 pt-2 border-t border-black/5 first:border-0 first:pt-0">
                  <div className="flex justify-between items-center gap-2">
                    <span className="font-semibold text-arctic-900">{item.label}</span>
                    <span className={`font-mono font-bold shrink-0 ${item.ok
                      ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {item.ok ? '✓ OK' : '✗ SHORT'}
                    </span>
                  </div>
                  {item.detail && (
                    <p className="text-2xs text-frost-muted mt-0.5">{item.detail}</p>
                  )}
                  {item.resupply && <ResupplyPanel resupply={item.resupply} />}
                </div>
              ))}

              {/* The line items say what is short. They do not say what is
                  holding the number down — a traverse can be 62% ready with
                  nothing flagged, and the commander authorising it should be
                  able to see which factor cost the points. */}
              <div className="mt-3 pt-3 border-t border-black/10">
                <ReadinessBreakdown result={feasibility} />
              </div>
            </div>
          )}

          {/* Readiness sits beside Save: the check belongs at the moment you
              commit the traverse, not while the form is still being written. */}
          <div className="flex flex-wrap justify-end gap-2">
            <button className="btn-secondary text-xs" onClick={handleCheck} disabled={checking}>
              <ClipboardCheck size={14} aria-hidden="true" />
              {checking ? 'Checking…' : 'Check Readiness'}
            </button>
            <button className="btn-primary text-xs tracking-wider uppercase" onClick={handleSave}
                    disabled={saving || !form.name.trim()}>
              {saving ? 'Saving…' : 'Save Expedition'}
            </button>
          </div>
        </div>

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <div className="subview-card rounded-2xl p-7 flex flex-col">
          <h2 className="section-heading mb-1">{station.label} Traverses</h2>
          <p className="text-2xs text-frost-muted mb-4">
            Authorising sends the crew out and draws the fuel from store. Completing brings
            them back.
          </p>
          {loading ? (
            <div className="space-y-3">{[1, 2, 3].map((i) => <LoadingCard key={i} />)}</div>
          ) : (
            <div className="flex-1 space-y-3 text-xs overflow-y-auto">
              {expeditions.length > 0 ? expeditions.map((e) => {
                const actions = NEXT_ACTIONS[e.status] ?? [];
                const crew = e.crew ?? [];
                const needs = (e.personnel_required ?? 0) - crew.length;
                const editing = crewEditFor === e.id;
                const degraded = e.readiness_degraded === true;
                const liveShortfalls = (e.live_feasibility ?? []).filter((i) => !i.ok);
                return (
                  <div key={e.id}
                       className={`p-3 rounded-xl border ${degraded
                         ? 'bg-amber-50/70 border-amber-300 ring-1 ring-amber-200'
                         : 'bg-arctic-50/60 border-arctic-200'}`}>
                    <div className="flex justify-between items-start gap-2 mb-1">
                      <span className="font-bold text-arctic-900 truncate">{e.name}</span>
                      <span data-compact
                            className={`shrink-0 px-2 py-0.5 rounded-full border font-mono
                                        text-2xs font-bold tracking-caps uppercase
                                        ${STATUS_STYLE[e.status] ?? STATUS_STYLE.draft}`}>
                        {STATUS_LABEL[e.status] ?? e.status}
                      </span>
                    </div>
                    <p className="text-2xs text-frost-muted">
                      {e.personnel_required} crew · {e.fuel_required_l?.toLocaleString()} L fuel
                      {e.live_readiness_score != null
                        ? ` · ${e.live_readiness_score}% ready now`
                        : e.readiness_score != null && ` · ${e.readiness_score}% ready`}
                    </p>

                    {/* A stored readiness score is a claim about a moment that
                        has passed. If a blizzard has since halved the fuel or
                        a rescue pulled crew off the roster, a card still
                        reading "100% ready" is how a departure gets authorised
                        on assumptions that expired hours ago. */}
                    {degraded && (
                      <div className="mt-2 p-2 rounded-lg border border-amber-300 bg-amber-50">
                        <p className="flex items-center gap-1.5 text-2xs font-bold
                                      text-amber-900">
                          <TrendingDown size={11} className="shrink-0" aria-hidden="true" />
                          FEASIBILITY DEGRADED ({e.baseline_readiness_score}% →{' '}
                          {e.live_readiness_score}%)
                        </p>
                        {liveShortfalls.length > 0 && (
                          <ul className="mt-1 space-y-0.5">
                            {liveShortfalls.map((item) => (
                              <li key={item.label} className="text-2xs text-amber-900">
                                <span className="font-semibold">{item.label}:</span>{' '}
                                {item.detail ?? `need ${item.required}, have ${item.available}`}
                              </li>
                            ))}
                          </ul>
                        )}
                        {liveShortfalls.map((item) => (
                          item.resupply
                            ? <ResupplyPanel key={`r-${item.label}`} resupply={item.resupply} />
                            : null
                        ))}
                        <button type="button" data-compact
                                disabled={rescoringId === e.id}
                                onClick={() => void handleRescore(e)}
                                className="btn-secondary !min-h-0 !px-2 !py-1 text-2xs w-full
                                           mt-2">
                          <ClipboardCheck size={11} aria-hidden="true" />
                          {rescoringId === e.id ? 'Re-scoring…' : 'Re-score & adjust'}
                        </button>
                      </div>
                    )}

                    {/* Roster */}
                    <div className="mt-2">
                      {crew.length > 0 ? (
                        <ul className="space-y-1">
                          {crew.map((c) => (
                            <li key={c.id}
                                className="flex items-center justify-between gap-2 text-2xs">
                              <span className="truncate text-arctic-900">
                                {c.name}
                                <span className="text-frost-muted"> · {c.role}</span>
                              </span>
                              {e.status === 'draft' && (
                                <button type="button" data-compact
                                        aria-label={`Remove ${c.name} from ${e.name}`}
                                        disabled={busyId === e.id}
                                        onClick={() => void updateCrew(e, c.id, false)}
                                        className="shrink-0 text-frost-muted hover:text-emergency
                                                   p-0.5 rounded transition-colors">
                                  <X size={11} aria-hidden="true" />
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : e.status === 'draft' ? (
                        <p className="text-2xs text-alert font-semibold">No crew assigned yet.</p>
                      ) : (
                        // A closed traverse has no roster because its crew were
                        // released back to the station, not because nobody went.
                        <p className="text-2xs text-frost-muted">
                          {e.personnel_required
                            ? `${e.personnel_required} crew released back to the roster.`
                            : 'No crew were assigned.'}
                        </p>
                      )}
                      {e.status === 'draft' && needs > 0 && (
                        <p className="text-2xs text-alert mt-1">
                          {needs} more needed before this can be authorised.
                        </p>
                      )}
                    </div>

                    {/* Add crew to a draft */}
                    {e.status === 'draft' && (
                      <div className="mt-2">
                        {editing ? (
                          <div className="space-y-1">
                            {available.length === 0 ? (
                              <p className="text-2xs text-frost-muted">Nobody free to add.</p>
                            ) : available.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                disabled={busyId === e.id}
                                onClick={() => void updateCrew(e, p.id, true)}
                                className="w-full text-left text-2xs px-2 py-1 rounded
                                           border border-frost-border bg-white
                                           hover:border-arctic-400 transition-colors truncate"
                              >
                                + {p.name} · {p.role}
                              </button>
                            ))}
                            <button type="button" data-compact
                                    onClick={() => setCrewEditFor(null)}
                                    className="text-2xs text-frost-muted hover:underline mt-1">
                              Done
                            </button>
                          </div>
                        ) : (
                          <button type="button" data-compact
                                  onClick={() => setCrewEditFor(e.id)}
                                  className="btn-secondary !min-h-0 !px-2 !py-1 text-2xs w-full">
                            <UserPlus size={11} aria-hidden="true" /> Add crew
                          </button>
                        )}
                      </div>
                    )}

                    {!degraded && ['draft', 'active'].includes(e.status) && (
                      <button type="button" data-compact
                              disabled={rescoringId === e.id}
                              onClick={() => void handleRescore(e)}
                              className="btn-secondary !min-h-0 !px-2 !py-1 text-2xs w-full mt-2">
                        <ClipboardCheck size={11} aria-hidden="true" />
                        {rescoringId === e.id ? 'Re-scoring…' : 'Re-score against live conditions'}
                      </button>
                    )}

                    {actions.length > 0 ? (
                      <div className="flex gap-1.5 mt-2.5">
                        {actions.map((a) => (
                          <button
                            key={a.to}
                            type="button"
                            data-compact
                            disabled={busyId === e.id}
                            onClick={() => void handleTransition(e, a.to)}
                            className={`!min-h-0 !px-2 !py-1 text-2xs flex-1 ${
                              a.tone === 'primary' ? 'btn-primary'
                                : a.tone === 'danger' ? 'btn-danger' : 'btn-secondary'}`}
                          >
                            {a.to === 'active' && <Play size={11} aria-hidden="true" />}
                            {a.to === 'completed' && <CheckCircle2 size={11} aria-hidden="true" />}
                            {a.to === 'cancelled' && <XCircle size={11} aria-hidden="true" />}
                            {a.label}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-2xs text-frost-muted mt-2 italic">
                        Closed — no further action.
                      </p>
                    )}
                  </div>
                );
              }) : (
                <div className="p-4 rounded-xl border border-dashed border-arctic-200
                                bg-arctic-50/40 text-center">
                  <p className="text-2xs text-frost-muted leading-relaxed">
                    No expeditions on record for {station.label}.<br />
                    Describe one above to get started.
                  </p>
                </div>
              )}
            </div>
          )}
          <div className="pt-4 border-t border-arctic-100 text-2xs text-frost-muted mt-4">
            Everything stays at the station. Changes made while the link is down are saved and
            sent when it returns.
          </div>
        </div>
      </div>
    </div>
  );
}
