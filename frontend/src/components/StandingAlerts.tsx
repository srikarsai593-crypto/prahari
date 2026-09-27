'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Link2, PackageMinus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useWebSocket } from './WebSocketProvider';
import type { StockAlert } from '@/lib/types';

/**
 * Alerts that outlive the tab they were raised in.
 *
 * A toast that vanishes in four seconds is not a record. If diesel crossed its
 * floor while the operator was on the Personnel page — or thirty minutes
 * before they logged in at all — nothing anywhere said so. Emergency incidents
 * stay open in the database until somebody closes them; low stock was
 * ephemeral, and a station can run a generator dry that way.
 *
 * The low-stock strip reads standing state from the backend, so it is correct
 * on a cold page load and not merely on the broadcast that raised it. The
 * cascade strip is the opposite: a one-off announcement of a chain of
 * consequences, dismissible because the facts behind it are all on their own
 * modules.
 */

interface CascadeNotice {
  key: string;
  summary: string;
  delayed: number;
  degraded: Array<{ expedition_id: string; name: string;
                    baseline_readiness: number; live_readiness: number }>;
}

export function StandingAlerts({ stationId }: { stationId: string }) {
  const { lastMessage } = useWebSocket();
  const [alerts, setAlerts] = useState<StockAlert[]>([]);
  const [cascade, setCascade] = useState<CascadeNotice | null>(null);

  const load = useCallback(async () => {
    if (!stationId) return;
    try {
      setAlerts(await api.listStockAlerts(stationId));
    } catch {
      // Leave the last known set in place rather than implying all-clear
      // because one fetch failed.
    }
  }, [stationId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!lastMessage) return;
    if (['inventory_alert', 'inventory_update', 'blizzard_update', 'shipment_update',
      'personnel_update', 'station_reset'].includes(lastMessage.type)) {
      void load();
    }
    if (lastMessage.type === 'cascade_alert' && lastMessage.data?.station === stationId) {
      setCascade({
        key: String(Date.now()),
        summary: lastMessage.data.summary ?? 'Supply chain cascade',
        delayed: lastMessage.data.delayed ?? 0,
        degraded: lastMessage.data.degraded ?? [],
      });
    }
  }, [lastMessage, load, stationId]);

  if (alerts.length === 0 && !cascade) return null;

  return (
    <div className="space-y-3">
      {/* ── Weather → cargo → expedition ─────────────────────────────────── */}
      {cascade && (
        <div role="status"
             className="rounded-2xl border border-rose-300 bg-rose-50/90 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-13 font-bold text-rose-900">
                <Link2 size={14} className="shrink-0" aria-hidden="true" />
                Supply Chain Cascade Alert
              </p>
              <p className="text-2xs text-rose-800 mt-1 leading-relaxed">{cascade.summary}</p>
              {cascade.degraded.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {cascade.degraded.map((exp) => (
                    <li key={exp.expedition_id} className="text-2xs text-rose-900">
                      <Link href="/expedition" className="font-semibold hover:underline">
                        {exp.name}
                      </Link>{' '}
                      readiness {exp.baseline_readiness}% → {exp.live_readiness}%
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button type="button" data-compact aria-label="Dismiss cascade alert"
                    onClick={() => setCascade(null)}
                    className="shrink-0 text-rose-700 hover:text-rose-900 px-2 py-1 rounded-md
                               hover:bg-white/60 transition-colors">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* ── Standing low stock ───────────────────────────────────────────── */}
      {alerts.length > 0 && (
        <div role="status"
             className="rounded-2xl border border-amber-300 bg-amber-50/90 p-4">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <p className="flex items-center gap-2 text-13 font-bold text-amber-900">
              <PackageMinus size={14} className="shrink-0" aria-hidden="true" />
              {alerts.length} standing stock alert{alerts.length > 1 ? 's' : ''}
            </p>
            <Link href="/inventory"
                  className="text-2xs font-mono tracking-caps uppercase text-amber-900
                             hover:underline">
              Open inventory
            </Link>
          </div>
          <p className="text-2xs text-amber-800 mt-1">
            These stay on record until stock recovers — they are not dismissible.
          </p>
          <ul className="mt-2 space-y-1">
            {alerts.slice(0, 5).map((alert) => (
              <li key={alert.item_id}
                  className="flex items-center justify-between gap-3 text-2xs bg-white
                             border border-amber-200 rounded-md px-2.5 py-1.5">
                <span className="font-semibold text-arctic-900 truncate">{alert.name}</span>
                <span className="font-mono text-rose-700 shrink-0">
                  {alert.days_of_cover.toFixed(1)}d cover
                  {alert.is_below_minimum && alert.minimum_threshold != null && (
                    <> · below {alert.minimum_threshold}{alert.unit ? ` ${alert.unit}` : ''} floor</>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {alerts.length > 5 && (
            <p className="text-2xs text-amber-800 mt-1.5">
              and {alerts.length - 5} more.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
