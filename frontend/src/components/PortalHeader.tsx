'use client';

import Link from 'next/link';
import { Headphones } from 'lucide-react';
import { Coordinate } from '@/components/Coordinate';
import { PrahariLogo } from '@/components/PrahariLogo';
import { useStation } from '@/components/StationProvider';
import { useStationConditions } from '@/lib/useStationConditions';
import { StationSwitcher } from '@/components/StationSwitcher';
import { MobileNav } from '@/components/MobileNav';

/**
 * Tier 2 — the station identity header.
 *
 * Carries the organisational shield, the portal wordmark, the active base
 * selector, and the three facts an operator checks before trusting anything
 * else on screen: where the station is, what the weather is doing to it, and
 * which channel raises a human.
 */
export function PortalHeader() {
  const { station, stationId, setStationId, ready } = useStation();
  const { deltaT } = useStationConditions(stationId);

  // Prahari has no meteorological sensor feed. The one environmental figure it
  // genuinely holds is the blizzard ΔT that Cargo writes and Inventory depletes
  // against, so that is what this reports — a fabricated temperature on an
  // operations console is indistinguishable from a measured one.
  const hasBlizzard = deltaT !== null && deltaT > 0;
  const ambientTone = !hasBlizzard ? 'text-nominal'
    : deltaT >= 25 ? 'text-emergency' : 'text-alert';

  return (
    <div className="bg-white border-b border-frost-border">
      <div className="max-w-portal mx-auto px-4 py-3 flex items-center justify-between gap-4">
        {/* Identity */}
        <div className="flex items-center gap-3.5 min-w-0">
          <Link href="/" className="shrink-0" aria-label="PRAHARI home">
            <span className="w-12 h-12 rounded-md bg-navy flex items-center justify-center
                             text-arctic-400 border border-navy-panel">
              <PrahariLogo size={26} halo={false} />
            </span>
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <Link href="/" className="text-2xl font-extrabold tracking-tight text-arctic-900
                                        leading-none">
                PRAHARI
              </Link>
              <StationSwitcher value={stationId} onChange={setStationId} ready={ready} />
            </div>
            <p className="text-13 text-arctic-900 font-semibold mt-1 truncate">
              National Antarctic Operations Intelligence &amp; Logistics Grid
            </p>
            <p className="hidden sm:block text-xs text-frost-muted font-mono mt-0.5 truncate">
              Ministry of Earth Sciences · Government of India{ready && ` · ${station.region}`}
            </p>
          </div>
        </div>

        {/* Telemetry block */}
        <div className="hidden lg:flex items-center gap-6 shrink-0">
          <div className="text-right">
            <div className="overline text-2xs">Station Coordinates</div>
            <div className="text-15 font-bold text-arctic-900 mt-0.5">
              <Coordinate lat={station.lat} lng={station.lng} />
            </div>
          </div>

          <div className="w-px h-9 bg-frost-border" aria-hidden="true" />

          <div className="text-right">
            <div className="overline text-2xs flex items-center justify-end gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${hasBlizzard ? 'bg-alert-fill' : 'bg-nominal-fill'}`}
                    aria-hidden="true" />
              Station Ambient
            </div>
            <div className={`metric text-15 mt-0.5 whitespace-nowrap ${ambientTone}`}>
              {deltaT === null ? 'No reading'
                : hasBlizzard ? `Blizzard ΔT +${deltaT.toFixed(1)}°C` : 'Nominal · ΔT 0.0°C'}
            </div>
          </div>

          {/* Prahari holds no directory of real emergency contacts. Printing an
              invented helpline number beside live telemetry is the kind of
              detail an operator would dial in an incident, so this points at
              the station's own emergency module instead of inventing one. */}
          <Link href="/emergency"
                className="flex items-center gap-3 border border-frost-border rounded-md
                           px-4 py-2 bg-frost-subtle hover:border-arctic-600 transition-colors">
            <Headphones size={20} className="text-arctic-600 shrink-0" aria-hidden="true" />
            <div>
              <div className="overline text-2xs">Emergency Response</div>
              <div className="text-13 font-bold text-arctic-900 leading-tight">
                Declare or review an incident
              </div>
            </div>
          </Link>
        </div>

        <MobileNav />
      </div>
    </div>
  );
}
