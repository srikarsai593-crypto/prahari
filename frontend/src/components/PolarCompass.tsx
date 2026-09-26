'use client';

import { useMemo } from 'react';
import type { Personnel } from '@/lib/types';
import type { StationInfo } from '@/lib/stations';

/**
 * Compass rose at the centre of the dashboard.
 *
 * Not decoration: it plots real personnel positions relative to the active
 * station, so the operator can see at a glance who is out and roughly where.
 * The rings are range bands, labelled with their actual radius.
 */
interface Props {
  station: StationInfo;
  personnel: Personnel[];
  /** Overrides the auto-fitted range band. */
  rangeKm?: number;
}

/** Range bands the plot snaps to, so the scale label is always a round number. */
const RANGE_STEPS_KM = [1, 2, 5, 10, 25, 50, 100, 250];

/** Out in the field per the roster, regardless of how far they happen to be. */
const DEPLOYED_STATUSES = new Set(['in_transit', 'field', 'deviated', 'sos']);

const SIZE = 200;
const CENTRE = SIZE / 2;
const PLOT_RADIUS = 78;           // px from centre to the outer ring
const METRES_PER_DEGREE_LAT = 111_320;

// Nominal Emerald / Polar Blue / Alert Amber / Emergency Red.
const STATUS_COLOR: Record<string, string> = {
  at_station: '#10b981',
  returned: '#10b981',
  field: '#0284c7',
  in_transit: '#f59e0b',
  deviated: '#ef4444',
  sos: '#ef4444',
  overdue: '#f59e0b',
};

export function PolarCompass({ station, personnel, rangeKm }: Props) {
  const { plotted, range } = useMemo(() => {
    const located = personnel.filter((p) => p.current_lat != null && p.current_lng != null);

    // Fit the scale to the furthest person so a station-local cluster does not
    // collapse into a single dot at the origin.
    const furthestKm = located.reduce((max, p) => {
      const dN = (p.current_lat! - station.lat) * METRES_PER_DEGREE_LAT;
      const dE = (p.current_lng! - station.lng) * METRES_PER_DEGREE_LAT
        * Math.cos((station.lat * Math.PI) / 180);
      return Math.max(max, Math.hypot(dN, dE) / 1000);
    }, 0);

    const fitted = rangeKm
      ?? RANGE_STEPS_KM.find((step) => step >= furthestKm * 1.25)
      ?? RANGE_STEPS_KM[RANGE_STEPS_KM.length - 1];
    const rangeM = fitted * 1000;

    const points = personnel
      .filter((p) => p.current_lat != null && p.current_lng != null)
      .map((p) => {
        // Equirectangular projection — accurate over the tens of kilometres
        // this widget covers, and it keeps north pointing up on screen.
        const dNorth = (p.current_lat! - station.lat) * METRES_PER_DEGREE_LAT;
        const dEast = (p.current_lng! - station.lng) * METRES_PER_DEGREE_LAT
          * Math.cos((station.lat * Math.PI) / 180);
        const distance = Math.hypot(dNorth, dEast);

        // Anyone beyond the range band is pinned to the rim rather than
        // dropped, so an operator never loses sight of someone far out.
        const scale = distance === 0 ? 0
          : Math.min(1, distance / rangeM) * PLOT_RADIUS / distance;

        return {
          id: p.id,
          name: p.name,
          status: p.effective_status ?? p.status,
          deployed: DEPLOYED_STATUSES.has(p.status),
          distanceKm: distance / 1000,
          beyondRange: distance > rangeM,
          x: CENTRE + dEast * scale,
          y: CENTRE - dNorth * scale,
        };
      });

    return { plotted: points, range: fitted };
  }, [personnel, station, rangeKm]);

  // "Deployed" is a roster fact, not a distance: someone 300 m from the hut is
  // still at the station.
  const deployed = plotted.filter((p) => p.deployed).length;

  return (
    <div className="w-full flex flex-col items-center">
      <div className="w-full max-w-[240px] aspect-square relative rounded-full compass-ring
                      flex items-center justify-center p-3">
        {/* Azimuth crosshair labels */}
        <span className="absolute top-1 left-1/2 -translate-x-1/2 text-xs font-bold text-arctic-700 font-mono tracking-caps">N</span>
        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-xs font-bold text-arctic-700 font-mono tracking-caps">S</span>
        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs font-bold text-arctic-700 font-mono tracking-caps">W</span>
        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs font-bold text-arctic-700 font-mono tracking-caps">E</span>

        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="w-full h-full"
          role="img"
          aria-label={`Range plot centred on ${station.name}, ${range} km radius. ${deployed} of ${plotted.length} personnel deployed.`}
        >
          <defs>
            <radialGradient id="compassWash" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#e0f2fe" stopOpacity="0.7" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="sweepFade" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.30" />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
            </linearGradient>
          </defs>

          <circle cx={CENTRE} cy={CENTRE} r={PLOT_RADIUS} fill="url(#compassWash)" />

          {/* Range bands, labelled with the distance they represent */}
          {[1, 2 / 3, 1 / 3].map((f) => (
            <circle
              key={f}
              cx={CENTRE} cy={CENTRE} r={PLOT_RADIUS * f}
              fill="none" stroke="#cbd5e1"
              strokeDasharray={f === 1 ? '4 4' : undefined}
              strokeWidth="1"
            />
          ))}
          <line x1={CENTRE} y1={CENTRE - PLOT_RADIUS} x2={CENTRE} y2={CENTRE + PLOT_RADIUS}
                stroke="#e2e8f0" strokeWidth="1" />
          <line x1={CENTRE - PLOT_RADIUS} y1={CENTRE} x2={CENTRE + PLOT_RADIUS} y2={CENTRE}
                stroke="#e2e8f0" strokeWidth="1" />

          {/* Sweep */}
          <g className="compass-sweep">
            <path
              d={`M ${CENTRE} ${CENTRE} L ${CENTRE + PLOT_RADIUS} ${CENTRE} `
                + `A ${PLOT_RADIUS} ${PLOT_RADIUS} 0 0 0 `
                + `${CENTRE + PLOT_RADIUS * Math.cos(-Math.PI / 5)} `
                + `${CENTRE + PLOT_RADIUS * Math.sin(-Math.PI / 5)} Z`}
              fill="url(#sweepFade)"
            />
          </g>

          {/* Station at the origin */}
          <circle cx={CENTRE} cy={CENTRE} r="4" fill="#0f172a" />
          <circle cx={CENTRE} cy={CENTRE} r="8" fill="none" stroke="#0f172a" strokeOpacity="0.28" />

          {/* Personnel */}
          {plotted.map((p) => (
            <g key={p.id}>
              <circle
                cx={p.x} cy={p.y} r={p.beyondRange ? 3 : 3.8}
                fill={STATUS_COLOR[p.status] ?? '#64748b'}
                stroke="#fff" strokeWidth="1.2"
                opacity={p.beyondRange ? 0.65 : 1}
              />
              <title>{`${p.name} — ${p.status.replace('_', ' ')} — ${p.distanceKm.toFixed(1)} km`}</title>
            </g>
          ))}

        </svg>

        {/* The range band is a telemetry reading, so it lives outside the SVG:
            inside it was fixed at 7.5 user units (~8px rendered) and could
            neither meet the 12px floor nor follow the text-size control. */}
        <span className="absolute top-5 right-5 metric text-xs text-frost-muted
                         pointer-events-none">
          {range < 1 ? `${range * 1000}m` : `${range}km`}
        </span>

        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-none">
          <span className="text-xs font-bold tracking-caps text-arctic-900 uppercase
                           font-mono bg-white px-2 py-0.5 rounded-full border border-frost-border
                           whitespace-nowrap">
            {station.name}
          </span>
        </div>
      </div>

      <p className="mt-3 text-xs text-frost-muted font-mono uppercase tracking-caps text-center">
        {plotted.length === 0
          ? 'Awaiting position fixes'
          : `${deployed} deployed · ${plotted.length - deployed} at station · ${
              range < 1 ? `${range * 1000} m` : `${range} km`} range`}
      </p>
    </div>
  );
}
