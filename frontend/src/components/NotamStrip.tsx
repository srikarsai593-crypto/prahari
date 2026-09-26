'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Radio } from 'lucide-react';
import { api } from '@/lib/api';
import { useStation } from '@/components/StationProvider';
import { useStationConditions } from '@/lib/useStationConditions';
import { useWebSocket } from '@/components/WebSocketProvider';

/**
 * Tier 4 — the NOTAM advisory strip.
 *
 * A standing operational readout directly under the navigation: current
 * advisory, verified head-count, thermal load and station clock. Every figure
 * is read from the backend; nothing here is decorative.
 */
const VERIFIED_AT_BASE = new Set(['at_station', 'returned']);

export function NotamStrip() {
  const { station, stationId, ready } = useStation();
  const { deltaT } = useStationConditions(stationId);
  const { lastMessage, connected } = useWebSocket();

  const [roster, setRoster] = useState<{ verified: number; total: number } | null>(null);
  const [clock, setClock] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const people = await api.listPersonnel(stationId);
      const list = Array.isArray(people) ? people : [];
      setRoster({
        verified: list.filter((p) => VERIFIED_AT_BASE.has(p.effective_status ?? p.status)).length,
        total: list.length,
      });
    } catch {
      setRoster(null);
    }
  }, [stationId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!lastMessage) return;
    if (['personnel_update', 'gps_update', 'accountability_update'].includes(lastMessage.type)) {
      void load();
    }
  }, [lastMessage, load]);

  // Rendered client-side only (after mount) so server and client markup agree.
  useEffect(() => {
    const tick = () => setClock(
      new Date().toISOString().slice(11, 19).replace(/:/g, ':') + 'Z',
    );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const hasBlizzard = deltaT !== null && deltaT > 0;
  // Held generic until the persisted station is known, so the strip never
  // names the wrong base for a frame.
  const advisory = !ready ? 'Reading station advisory…'
    : hasBlizzard
      ? `Blizzard load ΔT +${deltaT.toFixed(1)}°C applied — cargo risk and stock depletion re-scored`
      : `No active weather advisory for ${station.label} — traverse corridors open`;

  const rosterShort = roster && roster.verified < roster.total;

  return (
    <div className="notam-strip">
      <div className="max-w-portal mx-auto px-4 h-10 flex items-center gap-3 overflow-hidden">
        <span data-compact
              className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
                          font-bold tracking-caps border
                          ${hasBlizzard
                            ? 'bg-alert-tint border-alert-edge text-alert'
                            : 'bg-navy text-white border-navy'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${hasBlizzard ? 'bg-alert-fill' : 'bg-nominal-fill'}`}
                aria-hidden="true" />
          NOTAM LIVE
        </span>

        {/* The station id and its latitude band — both read from the station
            table, unlike the aviation-style NOTAM code this used to fabricate. */}
        <span data-compact className="hidden sm:inline shrink-0 px-2 py-1 rounded border
                                      border-frost-border bg-frost-subtle text-frost-muted
                                      font-bold tracking-caps">
          {ready ? `${station.id.toUpperCase()} · ${Math.round(Math.abs(station.lat))}°`
            + `${station.lat < 0 ? 'S' : 'N'}` : ' '}
        </span>

        <p className="flex-1 min-w-0 truncate text-arctic-900">
          <span className="font-bold">Sector Advisory:</span>{' '}
          <span className="text-frost-muted">{advisory}</span>
        </p>

        <div className="hidden lg:flex items-center gap-4 shrink-0 text-frost-muted">
          <Link href="/personnel"
                className={`font-bold tracking-caps hover:underline
                            ${rosterShort ? 'text-alert' : 'text-nominal'}`}>
            ROSTER: {roster ? `${roster.verified}/${roster.total} VERIFIED` : '—'}
          </Link>
          <span className="w-px h-4 bg-frost-border" aria-hidden="true" />
          {/* The genuine telemetry link state, not an invented radio channel. */}
          <span className={`inline-flex items-center gap-1.5 font-bold tracking-caps
                            ${connected ? 'text-nominal' : 'text-emergency'}`}>
            <Radio size={12} aria-hidden="true" /> {connected ? 'LINK UP' : 'LINK DOWN'}
          </span>
          <span className="w-px h-4 bg-frost-border" aria-hidden="true" />
          {/* suppressHydrationWarning: the clock is intentionally client-only. */}
          <span className="metric text-arctic-900 text-xs" suppressHydrationWarning>
            UTC {clock ?? '--:--:--Z'}
          </span>
        </div>
      </div>
    </div>
  );
}
