'use client';

import { useCallback, useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { useWebSocket } from './WebSocketProvider';
import { useStation } from './StationProvider';
import type { AppEvent } from '@/lib/types';

/**
 * The station's audit trail.
 *
 * Scoped to the console's active station: events now carry the base they
 * belong to, so the Maitri timeline no longer reports Bharati's activity as
 * its own. Station-agnostic entries (station === null — process-level and
 * cross-station rows) are shown on every console, which is what makes a
 * station reset or a backend restart visible everywhere.
 */
export const EventTimeline = () => {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const { lastMessage } = useWebSocket();
  const { station, stationId, ready } = useStation();

  // Tick every 60s to force re-render of relative timestamps
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(() => {
    let cancelled = false;
    api.listEvents({ station: stationId, limit: 20 })
      .then((data) => {
        if (cancelled) return;
        // Guard the fetch too: merging a live push that landed mid-request must
        // not reintroduce a duplicate.
        const seen = new Set<string>();
        setEvents((Array.isArray(data) ? data : [])
          .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))));
      })
      .catch(() => { if (!cancelled) setEvents([]); });
    return () => { cancelled = true; };
  }, [stationId]);

  useEffect(() => { if (ready) return load(); }, [load, ready]);

  useEffect(() => {
    // A station reset clears the trail everyone is looking at.
    if (lastMessage?.type === 'station_reset') load();
  }, [lastMessage, load]);

  useEffect(() => {
    if (lastMessage?.type !== 'event' || !lastMessage.data) return;
    const incoming = lastMessage.data as AppEvent;
    // The socket fans out to every console. Take this station's events plus
    // the station-agnostic ones, and drop another base's.
    if (incoming.station && incoming.station !== stationId) return;
    setEvents((prev) => {
      // A broadcast can arrive for an event the initial fetch already returned,
      // and React then renders two rows with the same key. Ids are unique in the
      // events table, so dedupe on the id and keep the newest copy.
      if (prev.some((e) => e.id === incoming.id)) return prev;
      return [incoming, ...prev].slice(0, 20);
    });
  }, [lastMessage, stationId]);

  // One accent per module, matching the colour that module carries elsewhere.
  const getModuleStyle = (module: string): { border: string; badge: string } => {
    switch (module) {
      case 'expedition': return { border: 'border-l-arctic-600', badge: 'bg-arctic-100 text-arctic-800 border-arctic-200' };
      case 'cargo':      return { border: 'border-l-alert-fill', badge: 'bg-alert-tint text-alert border-alert-edge' };
      case 'inventory':  return { border: 'border-l-nominal-fill', badge: 'bg-nominal-tint text-nominal border-nominal-edge' };
      case 'personnel':  return { border: 'border-l-violet-500', badge: 'bg-violet-50 text-violet-700 border-violet-200' };
      case 'emergency':  return { border: 'border-l-emergency-fill', badge: 'bg-emergency-tint text-emergency border-emergency-edge' };
      default:           return { border: 'border-l-slate-400', badge: 'bg-frost-subtle text-frost-muted border-frost-border' };
    }
  };

  // Called every render — recalculates based on current Date.now() due to tick state
  const timeAgo = (dateStr: string) => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000));
    if (seconds < 60)   return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  return (
    <div className="subview-card p-5 h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-4 pb-3
                      border-b border-frost-border">
        <h3 className="section-heading min-w-0">
          <Clock size={13} aria-hidden="true" />
          <span className="truncate">{ready ? `${station.label} Event Log` : 'Event Log'}</span>
        </h3>
        <span data-compact
              className="inline-flex items-center gap-1.5 font-mono text-xs font-bold
                         tracking-caps text-nominal shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-nominal-fill animate-pulse"
                aria-hidden="true" />
          Streaming
        </span>
      </div>
      <div className="flex-1 overflow-y-auto pr-1 space-y-3 font-mono text-xs">
        {events.map(event => {
          const { border, badge } = getModuleStyle(event.module);
          return (
            <div key={event.id}
                 className={`p-3 bg-frost-subtle border border-frost-border border-l-[3px]
                             ${border} rounded-r-md`}>
              <div className="flex justify-between items-center gap-2 text-2xs
                              text-frost-muted mb-1.5">
                <span data-compact
                      className={`px-2 py-0.5 rounded-full border text-2xs font-bold
                                  tracking-caps ${badge}`}>
                  {String(event.module || 'system').toUpperCase()}
                </span>
                <span className="shrink-0">{event.created_at ? timeAgo(event.created_at) : 'now'}</span>
              </div>
              <p className="text-arctic-900 font-medium leading-snug">{event.action}</p>
              {event.actor && (
                <p className="text-2xs text-frost-muted mt-1">by {event.actor}</p>
              )}
            </div>
          );
        })}
        {events.length === 0 && (
          <div className="p-3 bg-frost-subtle border border-frost-border border-l-[3px]
                          border-l-nominal-fill rounded-r-md">
            <div className="flex justify-between gap-2 text-2xs text-frost-muted mb-1.5">
              <span className="text-nominal font-bold tracking-caps">SYSTEM</span>
              <span>now</span>
            </div>
            <p className="text-arctic-900 font-medium leading-snug">
              Station telemetry channels linked. No operational events logged
              {ready ? ` at ${station.label}` : ''} yet.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
