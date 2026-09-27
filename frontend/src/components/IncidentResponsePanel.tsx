'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CheckSquare, ChevronUp, Radio, Square, TriangleAlert, Undo2,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from './Toast';
import type { Incident, IncidentSop, NearbyAsset } from '@/lib/types';

/**
 * Everything the commander can actually *do* about an open incident.
 *
 * The module could say who was missing and could not say what to do next:
 * assets were a read-only distance list, the protocol existed only in people's
 * heads, and severity and perimeter were frozen at declaration. All three are
 * live here.
 */

const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'] as const;

const ASSET_STATUS_STYLE: Record<string, string> = {
  available: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  standby: 'bg-sky-50 border-sky-200 text-sky-800',
  deployed: 'bg-amber-50 border-amber-200 text-amber-900',
  unavailable: 'bg-frost-subtle border-frost-border text-frost-muted',
};

interface Props {
  incident: Incident;
  assets: NearbyAsset[];
  onChanged: () => void;
}

export function IncidentResponsePanel({ incident, assets, onChanged }: Props) {
  const { addToast } = useToast();
  const [sop, setSop] = useState<IncidentSop | null>(null);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [busyAsset, setBusyAsset] = useState<string | null>(null);
  const [radius, setRadius] = useState(incident.affected_radius_m);
  const [savingRadius, setSavingRadius] = useState(false);
  const [escalating, setEscalating] = useState(false);

  const resolved = incident.status !== 'open';

  const loadSop = useCallback(async () => {
    try {
      setSop(await api.getIncidentSop(incident.id));
    } catch {
      setSop(null);
    }
  }, [incident.id]);

  useEffect(() => { void loadSop(); }, [loadSop]);
  // The slider follows the incident, not the other way round: a perimeter
  // widened from another console must not be silently overwritten by a stale
  // local value the next time this one saves.
  useEffect(() => { setRadius(incident.affected_radius_m); }, [incident.affected_radius_m]);

  const toggleTask = async (taskKey: string, done: boolean) => {
    setBusyTask(taskKey);
    try {
      setSop(await api.setIncidentSopTask(incident.id, taskKey, done));
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not record that step', 'alert');
    } finally { setBusyTask(null); }
  };

  const toggleAsset = async (asset: NearbyAsset) => {
    const deploying = asset.assigned_incident_id !== incident.id;
    setBusyAsset(asset.id);
    try {
      await api.dispatchAsset(asset.id, deploying ? incident.id : null);
      addToast(deploying
        ? `${asset.name} deployed to ${incident.type.replace('_', ' ')} incident`
        : `${asset.name} released and returned to service`,
        deploying ? 'warning' : 'success');
      onChanged();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not task that asset', 'alert');
    } finally { setBusyAsset(null); }
  };

  const escalate = async (to: Incident['severity']) => {
    setEscalating(true);
    try {
      await api.updateIncident(incident.id, { severity: to });
      addToast(`Severity raised to ${to}`, to === 'critical' ? 'alert' : 'warning');
      onChanged();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not change severity', 'alert');
    } finally { setEscalating(false); }
  };

  const saveRadius = async () => {
    setSavingRadius(true);
    try {
      const res = await api.updateIncident(incident.id, { affected_radius_m: radius });
      const count = res.accountability;
      addToast(count
        ? `Perimeter now ${(radius / 1000).toFixed(1)} km — ${count.unaccounted} of `
          + `${count.expected} unaccounted in the widened zone`
        : `Perimeter now ${(radius / 1000).toFixed(1)} km`,
        count && count.unaccounted > 0 ? 'warning' : 'success');
      onChanged();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not change the perimeter', 'alert');
    } finally { setSavingRadius(false); }
  };

  // An incident declared wider than the slider's nominal ceiling must not be
  // silently clamped down to it: dragging nothing and pressing Update would
  // then shrink the perimeter and drop people out of the head-count.
  const radiusCeiling = Math.max(10_000, incident.affected_radius_m);

  const currentIndex = SEVERITY_ORDER.indexOf(
    incident.severity as (typeof SEVERITY_ORDER)[number]);
  const higher = SEVERITY_ORDER.slice(currentIndex + 1);
  const radiusChanged = Math.abs(radius - incident.affected_radius_m) > 1;

  return (
    <div className="subview-card rounded-2xl p-5 space-y-5">
      <div>
        <h3 className="section-heading">Emergency Response Protocol</h3>
        <p className="text-2xs text-frost-muted mt-0.5">
          <span className="capitalize">{incident.type.replace('_', ' ')}</span> ·{' '}
          <span className="font-mono">{incident.id}</span>
        </p>
      </div>

      {/* ── SOP checklist ──────────────────────────────────────────────── */}
      {sop && sop.tasks.length > 0 ? (
        <div>
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <span className="overline">Standard Operating Procedure</span>
            <span className="text-2xs font-mono font-bold text-arctic-900">
              {sop.completed} of {sop.total} done
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-arctic-100 border border-arctic-200
                          overflow-hidden mb-2.5">
            <div className="h-full bg-emerald-500 rounded-full transition-[width] duration-300"
                 style={{ width: `${sop.total ? (sop.completed / sop.total) * 100 : 0}%` }} />
          </div>
          <ul className="space-y-1.5">
            {sop.tasks.map((task) => (
              <li key={task.task_key}>
                <button
                  type="button"
                  disabled={resolved || busyTask === task.task_key}
                  onClick={() => void toggleTask(task.task_key, !task.done)}
                  aria-pressed={task.done}
                  className={`w-full flex items-start gap-2 text-left p-2 rounded-lg border
                              transition-colors disabled:opacity-60 ${task.done
                                ? 'bg-emerald-50/70 border-emerald-200'
                                : 'bg-white border-frost-border hover:border-arctic-300'}`}
                >
                  {task.done
                    ? <CheckSquare size={13} className="shrink-0 mt-0.5 text-emerald-700"
                                   aria-hidden="true" />
                    : <Square size={13} className="shrink-0 mt-0.5 text-frost-muted"
                              aria-hidden="true" />}
                  <span className="min-w-0">
                    <span className={`block text-2xs leading-snug ${task.done
                      ? 'text-emerald-900 line-through decoration-emerald-400'
                      : 'text-arctic-900'}`}>
                      {task.label}
                    </span>
                    {task.done && task.done_at && (
                      <span className="block text-2xs font-mono text-emerald-700 mt-0.5">
                        Checked {new Date(task.done_at).toLocaleTimeString('en-GB', {
                          hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
                        })} UTC by {task.done_by ?? 'commander'}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-2xs text-frost-muted">
          No standard protocol is defined for this incident type.
        </p>
      )}

      {!resolved && (
        <>
          {/* ── Severity escalation ────────────────────────────────────── */}
          <div className="pt-4 border-t border-frost-border">
            <span className="overline block mb-1.5">Escalate Severity</span>
            {higher.length === 0 ? (
              <p className="text-2xs text-frost-muted">
                Already at the highest severity.
              </p>
            ) : (
              <>
                <p className="text-2xs text-frost-muted mb-2">
                  Currently <span className="font-mono font-bold capitalize">
                    {incident.severity}</span>. Escalating to critical puts a station-wide
                  banner on every connected console.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {higher.map((level) => (
                    <button
                      key={level}
                      type="button"
                      data-compact
                      disabled={escalating}
                      onClick={() => void escalate(level)}
                      className={`!min-h-0 !px-2.5 !py-1 text-2xs capitalize ${
                        level === 'critical' ? 'btn-danger' : 'btn-secondary'}`}
                    >
                      <ChevronUp size={11} aria-hidden="true" /> {level}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* ── Perimeter ──────────────────────────────────────────────── */}
          <div className="pt-4 border-t border-frost-border">
            <label htmlFor={`radius-${incident.id}`} className="overline">
              Affected radius — {(radius / 1000).toFixed(1)} km
            </label>
            <input
              id={`radius-${incident.id}`}
              type="range"
              min={500}
              max={radiusCeiling}
              step={250}
              value={radius}
              onChange={(e) => setRadius(parseInt(e.target.value, 10))}
            />
            <p className="text-2xs text-frost-muted mt-1">
              Widening it re-runs the head-count against the new circle — the old workaround,
              resolving and redeclaring, threw the running count away.
            </p>
            <div className="flex justify-end gap-2 mt-2">
              {radiusChanged && (
                <button type="button" data-compact
                        onClick={() => setRadius(incident.affected_radius_m)}
                        className="btn-secondary !min-h-0 !px-2.5 !py-1 text-2xs">
                  <Undo2 size={11} aria-hidden="true" /> Reset
                </button>
              )}
              <button type="button" data-compact disabled={!radiusChanged || savingRadius}
                      onClick={() => void saveRadius()}
                      className="btn-primary !min-h-0 !px-2.5 !py-1 text-2xs">
                {savingRadius ? 'Updating…' : 'Update Zone'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Asset dispatch ─────────────────────────────────────────────── */}
      <div className="pt-4 border-t border-frost-border">
        <span className="overline block mb-2">Nearest Assets</span>
        {assets.length === 0 ? (
          <p className="text-2xs text-frost-muted">No assets in range.</p>
        ) : (
          <div className="space-y-2">
            {assets.map((asset) => {
              const mine = asset.assigned_incident_id === incident.id;
              const elsewhere = !!asset.assigned_incident_id && !mine;
              return (
                <div key={asset.id}
                     className={`p-3 rounded-xl border ${mine
                       ? 'bg-amber-50/70 border-amber-200'
                       : 'bg-arctic-50 border-arctic-200'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-bold text-arctic-900 text-xs truncate">
                        {asset.name}
                      </div>
                      <div className="text-2xs text-frost-muted capitalize">
                        {asset.type} · {asset.distance_m} m away
                      </div>
                    </div>
                    <span data-compact
                          className={`shrink-0 px-2 py-0.5 rounded-full border text-2xs
                                      font-semibold font-mono ${
                                        ASSET_STATUS_STYLE[asset.status]
                                        ?? ASSET_STATUS_STYLE.unavailable}`}>
                      {asset.status}
                    </span>
                  </div>

                  {elsewhere ? (
                    <p className="text-2xs text-frost-muted mt-2 flex items-start gap-1.5">
                      <TriangleAlert size={11} className="shrink-0 mt-0.5" aria-hidden="true" />
                      Committed to {asset.assigned_incident_id} — release it there first.
                    </p>
                  ) : !resolved && asset.status !== 'unavailable' ? (
                    <button
                      type="button"
                      data-compact
                      disabled={busyAsset === asset.id}
                      onClick={() => void toggleAsset(asset)}
                      className={`w-full mt-2 !min-h-0 !px-2 !py-1 text-2xs ${mine
                        ? 'btn-secondary' : 'btn-primary'}`}
                    >
                      <Radio size={11} aria-hidden="true" />
                      {busyAsset === asset.id
                        ? 'Working…'
                        : mine ? 'Release / Return to Base' : 'Deploy to Incident'}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
