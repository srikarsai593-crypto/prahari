'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useWebSocket } from './WebSocketProvider';

/**
 * Station-wide banner for critical alerts (SOS, geofence violation, incident).
 *
 * Pinned above everything so a critical event is visible no matter which module
 * the operator is in — a toast that auto-dismisses after five seconds is the
 * wrong affordance for "someone is in a crevasse field".
 */
const CRITICAL_TYPES = new Set(['sos', 'geofence_violation', 'incident', 'power_failure',
  // An incident escalated to critical is exactly the case this banner exists
  // for: the record already exists, and what changed is that it now threatens
  // the station. It has to reach consoles that are not on the Emergency page.
  'incident_escalation']);

interface CriticalAlert {
  key: string;
  message: string;
  kind: string;
  /** The incident this banner is about, so its resolution can clear it. */
  incidentId?: string;
}

export function CriticalBanner() {
  const { lastMessage } = useWebSocket();
  const [alert, setAlert] = useState<CriticalAlert | null>(null);

  useEffect(() => {
    if (!lastMessage) return;

    /**
     * An emergency that has been dealt with must stop shouting.
     *
     * The banner only ever cleared when someone clicked Acknowledge, so a
     * resolved incident kept a full-width red bar over every page until each
     * console dismissed it by hand — and an operator who arrives afterwards
     * is told the station is in an emergency that ended an hour ago. A reset
     * clears it for the same reason: the incident it names no longer exists.
     */
    if (lastMessage.type === 'incident_update') {
      const { incident_id: id, status } = lastMessage.data ?? {};
      setAlert((current) => (status === 'resolved'
        && (current?.incidentId === undefined || current.incidentId === id)
        ? null : current));
      return;
    }
    if (lastMessage.type === 'station_reset') {
      setAlert(null);
      return;
    }

    if (lastMessage.type !== 'alert') return;
    const data = lastMessage.data ?? {};
    if (!CRITICAL_TYPES.has(data.type) && data.severity !== 'critical') return;

    const message: string = data.message
      ?? (data.type === 'sos' ? `SOS from ${data.personnel}`
        : data.type === 'geofence_violation'
          ? `${data.personnel} entered restricted zone "${data.geofence}"`
          : data.type === 'incident'
            ? `${String(data.incident_type ?? 'Incident').replace('_', ' ')} declared — `
              + `severity ${data.severity}`
            : 'Critical station alert');

    setAlert({
      key: `${Date.now()}`,
      message,
      kind: data.type ?? 'alert',
      incidentId: data.incident_id,
    });
  }, [lastMessage]);

  if (!alert) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="critical-banner sticky top-0 z-[70] bg-rose-600 text-white
                 px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3 shadow-lg"
    >
      <div className="flex items-center gap-3 min-w-0">
        {/* A steady ring, not an expanding ping. The banner is already a
            full-width red bar pinned above every page — it does not need a
            second device competing for the same attention. */}
        <span className="w-2.5 h-2.5 rounded-full bg-white ring-4 ring-rose-400/60 shrink-0
                         pulse-dot" aria-hidden="true" />
        <span className="text-xs uppercase tracking-widest font-bold bg-black/20
                         px-2.5 py-0.5 rounded font-mono shrink-0 hidden sm:inline">
          {alert.kind.replace('_', ' ')}
        </span>
        <p className="text-sm font-semibold tracking-wide truncate">{alert.message}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Link
          href="/emergency"
          data-compact
          className="text-xs bg-white/15 hover:bg-white/25 px-3 py-1.5 rounded-lg
                     border border-white/40 font-semibold transition-colors"
        >
          Respond
        </Link>
        <button
          type="button"
          data-compact
          onClick={() => setAlert(null)}
          aria-label="Acknowledge and dismiss alert"
          className="text-xs bg-black/20 hover:bg-black/30 px-3 py-1.5 rounded-lg
                     border border-white/40 font-medium transition-colors"
        >
          Acknowledge
        </button>
      </div>
    </div>
  );
}
