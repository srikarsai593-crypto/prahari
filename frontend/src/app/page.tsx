'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useWebSocket } from '@/components/WebSocketProvider';

const modules = [
  {
    title: 'Expedition Planning',
    desc: 'AI-assisted planning and feasibility checks.',
    href: '/expedition',
    icon: (
      <svg className="w-6 h-6 text-arctic-600" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
        <path d="M3 12l9-9 9 9M5 10v9a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1v-9" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    iconBg: 'bg-sky-50 border-sky-200',
    tag: 'EXP-PLN',
  },
  {
    title: 'Cargo & Logistics',
    desc: 'End-to-end tracking with dynamic risk scoring.',
    href: '/cargo',
    icon: (
      <svg className="w-6 h-6 text-arctic-600" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
        <rect x="1" y="3" width="15" height="13" rx="1" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M16 8h4l3 5v3h-7V8z" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx="5.5" cy="18.5" r="2.5"/>
        <circle cx="18.5" cy="18.5" r="2.5"/>
      </svg>
    ),
    iconBg: 'bg-amber-50 border-amber-200',
    tag: 'CGO-LOG',
  },
  {
    title: 'Inventory Management',
    desc: 'Predictive analytics based on weather data.',
    href: '/inventory',
    icon: (
      <svg className="w-6 h-6 text-arctic-600" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    iconBg: 'bg-emerald-50 border-emerald-200',
    tag: 'INV-MNG',
  },
  {
    title: 'Personnel Tracking',
    desc: 'Live GPS monitoring and geofencing alerts.',
    href: '/personnel',
    icon: (
      <svg className="w-6 h-6 text-arctic-600" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx="9" cy="7" r="4" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    iconBg: 'bg-violet-50 border-violet-200',
    tag: 'PRS-TRK',
  },
  {
    title: 'Emergency Response',
    desc: 'Instant SOS and automated accountability.',
    href: '/emergency',
    icon: (
      <svg className="w-6 h-6 text-rose-600" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" strokeLinecap="round" strokeLinejoin="round"/>
        <line x1="12" x2="12" y1="9" y2="13"/>
        <line x1="12" x2="12.01" y1="17" y2="17"/>
      </svg>
    ),
    iconBg: 'bg-rose-50 border-rose-200',
    tag: 'EMG-RSP',
  },
  {
    title: 'Live Scenario Demo',
    desc: 'Guided walkthrough of the system capabilities.',
    href: '/scenario',
    icon: (
      <svg className="w-6 h-6 text-arctic-600" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10"/>
        <polygon fill="currentColor" points="10 8 16 12 10 16 10 8"/>
      </svg>
    ),
    iconBg: 'bg-sky-50 border-sky-200',
    tag: 'SCN-DEM',
  },
];



export default function Home() {
  const { connected } = useWebSocket();
  const [kpi, setKpi] = useState<Record<string, string | number>>({});
  const [kpiLoading, setKpiLoading] = useState(true);

  useEffect(() => {
    const fetchKpis = async () => {
      try {
        const [expeditions, shipments, personnel, events] = await Promise.allSettled([
          api.listExpeditions(),
          api.listShipments(),
          api.listPersonnel(),
          api.listEvents(undefined, 100),
        ]);
        const expList   = expeditions.status === 'fulfilled'  ? (Array.isArray(expeditions.value)  ? expeditions.value  : []) : [];
        const shipList  = shipments.status  === 'fulfilled'   ? (Array.isArray(shipments.value)    ? shipments.value    : []) : [];
        const persList  = personnel.status  === 'fulfilled'   ? (Array.isArray(personnel.value)    ? personnel.value    : []) : [];
        const evtList   = events.status     === 'fulfilled'   ? (Array.isArray(events.value)       ? events.value       : []) : [];

        const today = new Date().toISOString().slice(0, 10);
        setKpi({
          expeditions: expList.filter((e: any) => e.status !== 'archived').length,
          shipments:   shipList.filter((s: any) => s.status === 'in_transit').length,
          personnel:   persList.filter((p: any) => ['in_transit', 'field', 'deviated'].includes(p.status)).length,
          events:      evtList.filter((e: any) => (e.created_at || '').startsWith(today)).length,
        });
      } catch (e) {
        console.error('KPI fetch failed', e);
      } finally {
        setKpiLoading(false);
      }
    };
    fetchKpis();
  }, []);

  const stats = [
    { label: 'Active Expeditions',   val: kpiLoading ? '…' : String(kpi.expeditions ?? 0), color: 'text-arctic-700' },
    { label: 'Shipments in Transit', val: kpiLoading ? '…' : String(kpi.shipments   ?? 0), color: 'text-arctic-700' },
    { label: 'Personnel Deployed',   val: kpiLoading ? '…' : String(kpi.personnel   ?? 0), color: 'text-arctic-700' },
    { label: 'Live Events Today',    val: kpiLoading ? '…' : String(kpi.events      ?? 0), color: connected ? 'text-emerald-600' : 'text-amber-600' },
  ];

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] max-w-5xl mx-auto">

      {/* ── Hero ── */}
      <div className="text-center mb-10 flex flex-col items-center">
        <div className="mb-5 flex justify-center items-center">
          <div className="snowflake-hero-wrapper group">
            <div className="snowflake-halo" />
            <svg
              className="w-14 h-14 snowflake-svg-element text-arctic-600"
              fill="none" stroke="currentColor" strokeWidth="1.7"
              strokeLinecap="round" strokeLinejoin="round"
              viewBox="0 0 24 24"
            >
              <line x1="12" x2="12" y1="2" y2="22"/>
              <line x1="2" x2="22" y1="12" y2="12"/>
              <line x1="4.93" x2="19.07" y1="4.93" y2="19.07"/>
              <line x1="19.07" x2="4.93" y1="4.93" y2="19.07"/>
              <path d="M12 4.5l-2.5-2.5m5 0L12 4.5M12 19.5l-2.5 2.5m5 0L12 19.5M4.5 12L2 9.5m0 5L4.5 12M19.5 12L22 9.5m0 5L19.5 12"/>
              <circle cx="12" cy="12" r="2" fill="currentColor"/>
            </svg>
          </div>
        </div>

        <span className="text-[11px] font-bold text-arctic-600 uppercase tracking-[0.24em] mb-2" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
          Expédition Polaire &amp; Sécurité
        </span>
        <h1 className="text-4xl md:text-5xl font-bold tracking-[0.18em] text-arctic-900 uppercase" style={{ fontFamily: 'Outfit, sans-serif' }}>
          PRAHARI
        </h1>
        <div className="title-accent-line" />
        <p className="text-frost-muted text-sm md:text-base font-normal max-w-lg mx-auto mt-3">
          Antarctic Logistics &amp; Safety Intelligence Platform
        </p>
      </div>

      {/* ── Module Cards — equal height via grid rows ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 w-full" style={{ gridAutoRows: '1fr' }}>
        {modules.map((m) => (
          <Link key={m.href} href={m.href} className="block h-full">
            <div className="portal-card rounded-2xl p-7 h-full group flex flex-col">
              {/* Top: icon + tag row */}
              <div className="flex items-start justify-between mb-4">
                <div className={`w-11 h-11 rounded-xl ${m.iconBg} border flex items-center justify-center group-hover:scale-105 transition-transform shadow-xs flex-shrink-0`}>
                  {m.icon}
                </div>
                <span className="text-[10px] font-semibold text-arctic-500 bg-arctic-50 border border-arctic-200 px-2 py-0.5 rounded-full font-mono tracking-wider">
                  {m.tag}
                </span>
              </div>
              {/* Bottom: title + desc — grows to fill */}
              <div className="flex flex-col flex-1 relative z-10">
                <h2 className="text-base font-bold text-arctic-900 mb-2 group-hover:text-arctic-600 transition-colors leading-snug" style={{ fontFamily: 'Outfit, sans-serif' }}>
                  {m.title}
                </h2>
                <p className="text-arctic-800/65 text-[13px] leading-relaxed flex-1">
                  {m.desc}
                </p>
                {/* Arrow — shows on hover */}
                <div className="mt-4 flex items-center gap-1 text-arctic-500 text-[11px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
                  Open Module
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* ── KPI Stats ── */}
      <div className="mt-12 w-full subview-card rounded-2xl px-6 py-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {stats.map((s) => (
            <div key={s.label} className="text-center">
              <div className={`text-2xl md:text-3xl font-bold mb-1 tracking-tight ${s.color}`} style={{ fontFamily: 'Outfit, sans-serif' }}>
                {s.val}
              </div>
              <div className="text-[10px] text-frost-muted uppercase tracking-widest" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
