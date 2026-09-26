'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Boxes, ChevronRight, Compass, Package, Search, ShieldAlert, Users, Play,
} from 'lucide-react';
import { api } from '@/lib/api';
import { offlineQueue } from '@/lib/offlineQueue';
import { useWebSocket } from '@/components/WebSocketProvider';
import { useStation } from '@/components/StationProvider';
import { PolarCompass } from '@/components/PolarCompass';
import { PrahariLogo } from '@/components/PrahariLogo';
import BlizzardCanvasLoader from '@/components/BlizzardCanvasLoader';
import { EventTimeline } from '@/components/EventTimeline';
import { useToast } from '@/components/Toast';
import type {
  Personnel, Shipment, InventoryItem, Expedition, Incident, MovementPlan,
} from '@/lib/types';

// ── Live snapshot ────────────────────────────────────────────────────────────
interface Snapshot {
  expeditions: Expedition[];
  shipments: Shipment[];
  inventory: InventoryItem[];
  personnel: Personnel[];
  incidents: Incident[];
  plans: MovementPlan[];
  deltaT: number | null;
}

const EMPTY: Snapshot = {
  expeditions: [], shipments: [], inventory: [], personnel: [],
  incidents: [], plans: [], deltaT: null,
};

type Tone = 'ok' | 'warn' | 'alert' | 'idle';

/** Status chip: colored dot + monospaced metric, per the telemetry badge spec. */
function StatusChip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const style = {
    ok: 'bg-nominal-tint border-nominal-edge text-nominal',
    warn: 'bg-alert-tint border-alert-edge text-alert',
    alert: 'bg-emergency-tint border-emergency-edge text-emergency',
    idle: 'bg-frost-subtle border-frost-border text-frost-muted',
  }[tone];
  const dot = {
    ok: 'bg-nominal-fill', warn: 'bg-alert-fill',
    alert: 'bg-emergency-fill', idle: 'bg-slate-400',
  }[tone];
  return (
    <span data-compact
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border
                      font-mono text-xs font-bold tracking-caps uppercase whitespace-nowrap
                      shrink-0 ${style}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} aria-hidden="true" />
      {children}
    </span>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const { addToast } = useToast();
  const { connected, lastMessage } = useWebSocket();
  const { station, stationId, ready } = useStation();

  const [data, setData] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [pendingWrites, setPendingWrites] = useState(0);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const unsub = offlineQueue.subscribe(() => setPendingWrites(offlineQueue.pendingCount));
    setPendingWrites(offlineQueue.pendingCount);
    return unsub;
  }, []);

  const load = useCallback(async () => {
    // allSettled: one failing module must not blank the whole dashboard.
    const [exp, ship, inv, pers, inc, plans, cond] = await Promise.allSettled([
      api.listExpeditions({ station: stationId }),
      api.listShipments({ station: stationId }),
      api.listInventory({ station: stationId }),
      api.listPersonnel(stationId),
      api.listIncidents({ status: 'open', station: stationId }),
      api.listMovementPlans(stationId),
      api.getStationConditions(),
    ]);
    const ok = <T,>(r: PromiseSettledResult<T[]>): T[] =>
      r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : [];

    setData({
      expeditions: ok<Expedition>(exp),
      shipments: ok<Shipment>(ship),
      inventory: ok<InventoryItem>(inv),
      personnel: ok<Personnel>(pers),
      incidents: ok<Incident>(inc),
      plans: ok<MovementPlan>(plans),
      deltaT: cond.status === 'fulfilled' ? (cond.value?.stations?.[stationId] ?? 0) : null,
    });
    setLoading(false);
  }, [stationId]);

  // Waits for the persisted station choice so the first fetch is not thrown
  // away by an immediate refetch against a different station.
  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    void load();
  }, [load, ready]);

  // Refresh on any state-changing broadcast rather than polling on a timer.
  useEffect(() => {
    if (!lastMessage) return;
    const REFRESH_ON = new Set([
      'gps_update', 'alert', 'inventory_update', 'blizzard_update',
      'personnel_update', 'shipment_update', 'accountability_update', 'incident_update',
      'expedition_update', 'station_reset',
    ]);
    if (REFRESH_ON.has(lastMessage.type)) void load();
  }, [lastMessage, load]);

  // ── Derived module state — every figure below traces to a real record ──────
  const m = useMemo(() => {
    const { expeditions, shipments, inventory, personnel, incidents, plans } = data;

    // Now that expeditions have a lifecycle, 'active' means authorised and
    // under way. This KPI used to count drafts as active, so it reported
    // traverses that had never been resourced or approved.
    const activeExpeditions = expeditions.filter((e) => e.status === 'active');
    const draftExpeditions = expeditions.filter((e) => e.status === 'draft');
    const inTransit = shipments.filter((s) => s.status === 'in_transit').length;
    const delayed = shipments.filter((s) => s.status === 'delayed').length;
    const openPlans = plans.filter((p) => ['planned', 'in_transit'].includes(p.status));
    const deviated = plans.filter((p) => p.status === 'deviated').length;

    // Stock runway = the item that runs out first. That is the number that
    // actually constrains the station.
    const covers = inventory
      .map((i) => i.days_of_cover)
      .filter((d): d is number => typeof d === 'number' && d < 9999);
    const minCover = covers.length ? Math.min(...covers) : null;
    const critical = inventory.filter(
      (i) => typeof i.days_of_cover === 'number' && i.days_of_cover < 15).length;

    const deployed = personnel.filter(
      (p) => ['in_transit', 'field', 'deviated'].includes(p.status)).length;
    const unaccounted = incidents.reduce((n, i) => n + (i.unaccounted_count ?? 0), 0);
    const overdue = personnel.filter((p) => p.overdue).length;

    return {
      activeExpeditions, draftExpeditions, inTransit, delayed, openPlans, deviated,
      minCover, critical, deployed, unaccounted, overdue,
      totalPersonnel: personnel.length,
      openIncidents: incidents.length,
    };
  }, [data]);

  // ── Universal lookup ──────────────────────────────────────────────────────
  // Resolves a traverse id, consignment barcode, person or stock item against
  // the snapshot already in hand and opens the module that owns it. Matching
  // locally means it still answers when the station link is down.
  /**
   * Suggestions built from what this station actually holds.
   *
   * The chips used to be a fixed list — "Traverse Corridor" and "Fuel Depot"
   * match nothing in the seed data, so two of the four always produced a
   * "nothing matches" warning. These are drawn from the snapshot already in
   * hand, so every chip resolves.
   */
  const lookups = useMemo(() => {
    const suggestions: string[] = [];
    const push = (value?: string | null) => {
      if (value && !suggestions.includes(value)) suggestions.push(value);
    };
    // One of each kind the lookup can resolve, so the chips demonstrate the
    // whole search rather than four of the same thing.
    push(data.shipments[0]?.barcode_id);
    push(data.personnel[0]?.name);
    push(data.expeditions[0]?.name);
    data.inventory.slice(0, 2).forEach((i) => push(i.name));
    return suggestions.slice(0, 4);
  }, [data]);

  const runLookup = useCallback((raw: string) => {
    const q = raw.trim().toLowerCase();
    if (!q) return;
    const hit = (v?: string | null) => !!v && v.toLowerCase().includes(q);

    const shipment = data.shipments.find(
      (s) => hit(s.barcode_id) || hit(s.id) || hit(s.item_name));
    if (shipment) {
      addToast(`Consignment ${shipment.barcode_id} — ${shipment.status.replace('_', ' ')}`, 'info');
      return router.push('/cargo');
    }

    const person = data.personnel.find((p) => hit(p.id) || hit(p.name) || hit(p.role));
    if (person) {
      addToast(`${person.name} — ${(person.effective_status ?? person.status).replace('_', ' ')}`,
        'info');
      return router.push('/personnel');
    }

    const expedition = data.expeditions.find((e) => hit(e.id) || hit(e.name));
    if (expedition) {
      addToast(`${expedition.name} — ${expedition.status}`, 'info');
      return router.push('/expedition');
    }

    const item = data.inventory.find((i) => hit(i.id) || hit(i.name));
    if (item) {
      addToast(`${item.name} — ${item.quantity} ${item.unit ?? ''} in stock`, 'info');
      return router.push('/inventory');
    }

    addToast(`No traverse, consignment, person or stock item at ${station.label} matches "${raw.trim()}"`,
      'warning');
  }, [data, router, addToast, station.label]);

  const dash = loading ? '—' : undefined;

  const kpis: Array<{ value: string; label: string; tone: string; href: string;
                     note?: string }> = [
    {
      value: dash ?? String(m.activeExpeditions.length),
      label: 'Active Expeditions', tone: 'text-arctic-900', href: '/expedition',
      note: m.draftExpeditions.length > 0
        ? `${m.draftExpeditions.length} draft awaiting authorisation` : undefined,
    },
    {
      value: dash ?? String(m.inTransit),
      label: 'Consignments in Transit', tone: 'text-arctic-900', href: '/cargo',
    },
    {
      value: dash ?? String(m.deployed),
      label: 'Personnel Deployed', tone: 'text-arctic-900', href: '/personnel',
    },
    {
      value: dash ?? (m.minCover === null ? 'n/a' : `${m.minCover.toFixed(0)}d`),
      label: 'Shortest Stock Cover',
      tone: m.critical > 0 ? 'text-emergency' : 'text-arctic-900',
      href: '/inventory',
    },
  ];

  // ── Core services grid ────────────────────────────────────────────────────
  const modules = [
    {
      code: 'MOD-01', href: '/expedition', icon: Compass,
      title: 'Expedition & Traverse',
      desc: 'Plan a traverse, name the crew going on it and check the station can support it '
        + 'before anyone departs.',
      chip: (<StatusChip tone={m.activeExpeditions.length ? 'ok'
        : m.draftExpeditions.length ? 'warn' : 'idle'}>
        {m.activeExpeditions.length} active · {m.draftExpeditions.length} draft
      </StatusChip>),
      links: [
        ['Parse a commander request', '/expedition'],
        ['Run a feasibility check', '/expedition'],
        [m.draftExpeditions.length > 0
          ? `Authorise ${m.draftExpeditions.length} draft traverse(s)`
          : 'No drafts awaiting authorisation', '/expedition'],
        [`Active corridors (${m.openPlans.length})`, '/personnel'],
      ] as [string, string][],
    },
    {
      code: 'MOD-02', href: '/cargo', icon: Package,
      title: 'Cargo & Logistics',
      desc: 'Track every inbound crate from dispatch to unloading, and see how the weather is '
        + 'affecting what is still on its way.',
      chip: (<StatusChip tone={m.delayed > 0 ? 'warn' : data.shipments.length ? 'ok' : 'idle'}>
        {m.delayed > 0 ? `${m.delayed} delayed` : `${data.shipments.length} active`}
      </StatusChip>),
      links: [
        ['QR manifest verification', '/cargo'],
        [`Consignment status (${m.inTransit} in transit)`, '/cargo'],
        ['Apply blizzard risk impact', '/cargo'],
        ['Register a new shipment', '/cargo'],
      ] as [string, string][],
    },
    {
      code: 'MOD-03', href: '/inventory', icon: Boxes,
      title: 'Inventory & Life Support',
      desc: 'What the station is holding, how fast it is going, and how many days are left at '
        + 'the current rate.',
      chip: (<StatusChip tone={m.critical > 0 ? 'alert' : m.minCover !== null ? 'ok' : 'idle'}>
        {m.minCover === null ? 'no data' : `${m.minCover.toFixed(0)}d cover`}
      </StatusChip>),
      links: [
        ['Stock levels & days remaining', '/inventory'],
        ['Count what is on the shelf', '/inventory'],
        ['Text stock adjustment', '/inventory'],
        [m.critical > 0 ? `${m.critical} items below 15d` : 'Life-support spares', '/inventory'],
      ] as [string, string][],
    },
    {
      code: 'MOD-04', href: '/personnel', icon: Users,
      title: 'Personnel & Safety',
      desc: 'Where everyone is, alerts when someone strays off an authorised route, and a '
        + 'head-count of who is back at base.',
      chip: (<StatusChip tone={m.deviated > 0 || m.overdue > 0 ? 'alert'
        : m.deployed > 0 ? 'warn' : 'ok'}>
        {m.deployed > 0 ? `${m.deployed} deployed` : `${m.totalPersonnel} at base`}
      </StatusChip>),
      links: [
        ['View base personnel roster', '/personnel'],
        ['Authorise a movement plan', '/personnel'],
        ['Geofence status grid', '/personnel'],
        [m.overdue > 0 ? `${m.overdue} overdue check-in` : 'All check-ins current', '/personnel'],
      ] as [string, string][],
    },
  ];

  return (
    <div className="space-y-8">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative bg-navy rounded-lg border border-navy-panel overflow-hidden">
        {/* Katabatic drift, scoped to this section and sitting behind the copy.
            It pauses when the hero scrolls away and renders nothing at all
            under prefers-reduced-motion. */}
        <BlizzardCanvasLoader />

        <div className="relative z-10 px-6 sm:px-10 py-9">
          <span data-compact
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border
                           border-white/20 bg-white/5 font-mono text-xs font-bold
                           tracking-caps uppercase text-slate-200">
            <span className="w-1.5 h-1.5 rounded-full bg-arctic-400" aria-hidden="true" />
            Official Portal of the Indian Antarctic Programme{ready && ` · ${station.label}`}
          </span>

          <div className="mt-5 flex items-center gap-5">
            <PrahariLogo size={56} className="text-arctic-400 hidden sm:block" />
            <h1 className="text-3xl sm:text-[2.75rem] font-extrabold tracking-tight text-white
                           leading-tight">
              Welcome to PRAHARI Antarctic Operations
            </h1>
          </div>
          <p className="mt-3 max-w-3xl text-15 leading-relaxed text-slate-300">
            Unified real-time logistics intelligence, traverse passage clearances, life-support
            resource tracking and field safety protocols under the aegis of NCPOR &amp; MoES.
          </p>

          {/* Universal lookup */}
          <form
            className="mt-7 flex flex-col sm:flex-row gap-2.5 max-w-4xl"
            onSubmit={(e) => { e.preventDefault(); runLookup(query); }}
            role="search"
          >
            <div className="relative flex-1">
              <Search size={18} aria-hidden="true"
                      className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400
                                 pointer-events-none" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search traverses, consignments, personnel and stock"
                placeholder="Enter Traverse ID / Consignment No. / Personnel name / Stock item…"
                className="w-full !bg-white/5 !border-white/20 !text-white !pl-11 !py-3
                           placeholder:!text-slate-400 font-mono text-13"
              />
            </div>
            <button type="submit"
                    className="btn-primary shrink-0 !px-7 !py-3 tracking-caps uppercase text-13">
              Track &amp; Verify
            </button>
          </form>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs tracking-caps uppercase text-slate-400 mr-1">
              {lookups.length > 0 ? `On record at ${station.label}:` : 'Nothing on record yet'}
            </span>
            {lookups.map((l) => (
              <button
                key={l}
                type="button"
                data-compact
                onClick={() => { setQuery(l); runLookup(l); }}
                className="px-3 py-1.5 rounded border border-white/20 bg-white/5 font-mono
                           text-xs text-slate-200 hover:bg-white/10 hover:border-arctic-400
                           transition-colors"
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Operational status ───────────────────────────────────────────── */}
      <section aria-labelledby="status-heading">
        <h2 id="status-heading" className="section-heading mb-1">
          {ready ? `${station.label} Operational Status` : 'Station Operational Status'}
        </h2>
        <p className="text-13 text-frost-muted mb-4 ml-[18px]">
          Live figures for the active station. Values refresh on station broadcast, not on a timer.
        </p>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {kpis.map((k) => (
            <Link key={k.label} href={k.href}
                  className="portal-card p-5 group focus-visible:outline-offset-0">
              <div className={`metric text-[2rem] leading-none ${k.tone}
                               ${loading ? 'opacity-40' : ''}`}>
                {k.value}
              </div>
              <div className="overline mt-2.5">{k.label}</div>
              {k.note && (
                <div className="text-2xs text-alert font-semibold mt-1">{k.note}</div>
              )}
              <div className="mt-3 pt-3 border-t border-frost-border flex items-center
                              justify-between text-2xs text-arctic-600 font-semibold">
                <span>Open module</span>
                <ArrowRight size={13} aria-hidden="true"
                            className="group-hover:translate-x-1 transition-transform" />
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ── Core services ────────────────────────────────────────────────── */}
      <section aria-labelledby="modules-heading">
        <h2 id="modules-heading" className="section-heading mb-1">
          Station Core Services &amp; Operational Modules
        </h2>
        <p className="text-13 text-frost-muted mb-4 ml-[18px]">
          The five areas this station runs day to day. Every figure below is read from the
          station&apos;s own records.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {modules.map((mod) => (
            <article key={mod.code} className="portal-card flex flex-col">
              <div className="p-5">
                <div className="flex items-start justify-between gap-2 mb-4">
                  <span className="card-icon">
                    <mod.icon size={19} aria-hidden="true" />
                  </span>
                  <span className="font-mono text-xs font-bold tracking-caps text-frost-muted">
                    {mod.code}
                  </span>
                </div>

                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="text-15 font-bold uppercase tracking-caps text-arctic-900
                                 leading-snug">
                    {mod.title}
                  </h3>
                </div>
                {mod.chip}
                <p className="mt-3 text-13 leading-relaxed text-frost-muted">{mod.desc}</p>
              </div>

              <ul className="mt-auto border-t border-frost-border divide-y divide-frost-border">
                {mod.links.map(([label, href], i) => (
                  <li key={`${mod.code}-${i}`}>
                    <Link href={href}
                          className="flex items-center justify-between gap-2 px-5 py-3 text-13
                                     text-arctic-900 hover:bg-frost-subtle hover:text-arctic-700
                                     transition-colors group">
                      <span className="truncate">{label}</span>
                      <ChevronRight size={14} aria-hidden="true"
                                    className="text-frost-muted shrink-0
                                               group-hover:text-arctic-600
                                               group-hover:translate-x-0.5 transition-all" />
                    </Link>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      {/* ── Live operations ──────────────────────────────────────────────── */}
      <section aria-labelledby="ops-heading">
        <h2 id="ops-heading" className="section-heading mb-4">
          Live Field Telemetry &amp; Emergency Posture
        </h2>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          {/* Radar */}
          <div className="lg:col-span-4 portal-card p-5 flex flex-col">
            <div className="flex items-center justify-between gap-2 mb-4">
              <span className="overline">Field Position Plot</span>
              <span className="font-mono text-xs font-bold tracking-caps text-frost-muted">
                {ready ? station.id.toUpperCase() : ' '}
              </span>
            </div>
            <div className="flex-1 flex items-center justify-center">
              {/* The plot is centred on the active station, so it waits for the
                  persisted choice rather than drawing the default first. */}
              {ready ? (
                <PolarCompass station={station} personnel={data.personnel} />
              ) : (
                <div className="w-full max-w-[240px] aspect-square rounded-full compass-ring
                                animate-pulse" aria-hidden="true" />
              )}
            </div>
          </div>

          {/* Emergency posture */}
          <div className="lg:col-span-4 flex flex-col gap-4">
            <article className="portal-card portal-card--alert p-5 flex-1 flex flex-col">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="card-icon card-icon--alert">
                    <ShieldAlert size={19} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <span className="overline block text-2xs">Module 05</span>
                    <h3 className="text-15 font-bold uppercase text-emergency
                                   leading-snug mt-0.5 tracking-tight">
                      Emergency Response
                    </h3>
                  </div>
                </div>
                <StatusChip tone={m.unaccounted > 0 ? 'alert' : m.openIncidents > 0 ? 'warn' : 'ok'}>
                  {m.unaccounted > 0 ? `${m.unaccounted} missing`
                    : m.openIncidents > 0 ? `${m.openIncidents} open` : 'nominal'}
                </StatusChip>
              </div>

              <p className="text-13 leading-relaxed text-frost-muted">
                Raise an alarm, count who is inside the affected area, and find the nearest
                rescue vehicle or medical kit.
              </p>

              <dl className="grid grid-cols-3 gap-2 mt-4 font-mono text-xs">
                {[
                  ['Weather', data.deltaT ? `ΔT +${data.deltaT.toFixed(0)}°C` : 'Clear'],
                  ['At base', `${m.totalPersonnel - m.deployed}/${m.totalPersonnel}`],
                  ['Comms', connected ? 'Up' : 'Down'],
                ].map(([label, value]) => (
                  <div key={label} className="inset-panel px-2.5 py-2">
                    <dt className="text-2xs uppercase tracking-caps text-frost-muted">
                      {label}
                    </dt>
                    <dd className="font-bold text-arctic-900 truncate mt-0.5">{value}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-4 pt-4 border-t border-frost-border flex gap-2">
                <Link href="/emergency" className="btn-danger flex-1 text-13">
                  Declare Emergency
                </Link>
                <Link href="/emergency" className="btn-secondary text-13">
                  SOP
                </Link>
              </div>
            </article>

            <Link href="/scenario" className="group">
              <article className="portal-card portal-card--invert p-4 flex items-center
                                  justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-10 h-10 rounded-md bg-arctic-600/25 border border-arctic-400
                                   flex items-center justify-center text-white shrink-0">
                    <Play size={17} className="fill-current" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-13 font-bold uppercase tracking-caps leading-tight">
                      Live Scenario
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5 truncate">
                      A guided run through everything the station does.
                    </p>
                  </div>
                </div>
                <ArrowRight size={16} aria-hidden="true"
                            className="text-arctic-400 shrink-0 group-hover:translate-x-1
                                       transition-transform" />
              </article>
            </Link>
          </div>

          {/* Timeline — a definite height, not a minimum: the card inside is
              `h-full` with an internal scroll region, and against a min-height
              parent that resolves to auto and the list grows the whole row. */}
          <div className="lg:col-span-4 h-[460px]">
            <EventTimeline />
          </div>
        </div>
      </section>
    </div>
  );
}
