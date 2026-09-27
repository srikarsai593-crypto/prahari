'use client';

import { Compass, Gauge, MapPin, Timer } from 'lucide-react';
import type { Telemetry } from '@/lib/types';

/**
 * Playback progress and navigation telemetry for a tracked operative.
 *
 * Both of these read data the backend was already computing and the personnel
 * card was already discarding: `simulate-move` returns `progress` on every
 * fix, and now `telemetry` alongside it. Without them the tracking console is
 * a dot crawling across a map beside two decimal numbers, which tells an
 * operator neither how far along the party is nor whether the feed has
 * stalled.
 */

interface ProgressProps {
  progress?: { step: number; total: number; percent: number } | null;
  arrived?: boolean;
  active?: boolean;
  deviated?: boolean;
}

export function TraverseProgress({ progress, arrived, active, deviated }: ProgressProps) {
  // Nothing to report until there is a plan being walked. An empty strip on
  // every row of the roster would be noise.
  if (!progress || progress.total === 0 || (!active && !arrived)) return null;

  const percent = arrived ? 100 : Math.min(100, Math.max(0, progress.percent));
  const barTone = arrived ? 'bg-emerald-500' : deviated ? 'bg-rose-500' : 'bg-sky-500';

  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="overline">Traverse Progress</span>
        <span className="text-2xs font-mono font-bold text-arctic-900">
          {arrived
            ? 'Arrived at destination'
            : `Fix ${progress.step} of ${progress.total} (${percent}%)`}
        </span>
      </div>
      <div
        className="h-2 w-full rounded-full bg-arctic-100 border border-arctic-200
                   overflow-hidden"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Traverse progress"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${barTone}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {arrived && (
        <span className="mt-1.5 inline-block px-2 py-0.5 rounded-full border text-2xs
                         font-semibold bg-emerald-50 border-emerald-200 text-emerald-800">
          Arrived at Destination
        </span>
      )}
    </div>
  );
}

interface HudProps {
  telemetry?: Telemetry | null;
  destination?: string;
}

const pad3 = (n: number) => String(Math.round(n)).padStart(3, '0');

/** `39m`, or `2h 14m` once the remaining leg runs past an hour. */
const formatEta = (minutes: number) => (minutes < 60
  ? `${minutes}m`
  : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`);

export function TelemetryHud({ telemetry, destination }: HudProps) {
  if (!telemetry) return null;

  const readings: Array<{ icon: typeof Compass; label: string; value: string }> = [
    {
      icon: Compass,
      label: 'Heading',
      value: telemetry.heading_deg === null
        // A stationary fix has no heading. Rendering 000 would assert due
        // north, which is a bearing, not an absence of one.
        ? '—'
        : `${pad3(telemetry.heading_deg)}° ${telemetry.heading_compass ?? ''}`.trim(),
    },
    {
      icon: Gauge,
      label: 'Speed',
      value: telemetry.speed_kmh === null ? '—' : `${telemetry.speed_kmh.toFixed(1)} km/h`,
    },
    {
      icon: MapPin,
      label: 'Remaining',
      value: `${telemetry.distance_remaining_km.toFixed(1)} km`,
    },
    {
      icon: Timer,
      label: 'ETA',
      value: telemetry.eta_minutes === null ? '—' : formatEta(telemetry.eta_minutes),
    },
  ];

  return (
    <div className="mb-3 rounded-xl border border-arctic-700 bg-arctic-900 px-3 py-2.5
                    text-white">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <span className="text-2xs font-mono uppercase tracking-caps text-arctic-300">
          Live Telemetry
        </span>
        {destination && (
          <span className="text-2xs font-mono text-arctic-300 truncate">→ {destination}</span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
        {readings.map(({ icon: Icon, label, value }) => (
          <div key={label} className="min-w-0">
            <dt className="flex items-center gap-1 text-2xs uppercase tracking-caps
                           text-arctic-400">
              <Icon size={10} aria-hidden="true" /> {label}
            </dt>
            <dd className="font-mono font-bold text-13 text-white truncate">{value}</dd>
          </div>
        ))}
      </dl>
      {telemetry.eta_at && (
        <p className="mt-2 pt-2 border-t border-white/10 text-2xs font-mono text-arctic-300">
          Estimated arrival {new Date(telemetry.eta_at).toLocaleTimeString('en-GB', {
            hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
          })} UTC
        </p>
      )}
    </div>
  );
}
