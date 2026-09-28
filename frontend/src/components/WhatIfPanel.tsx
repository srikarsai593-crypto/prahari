'use client';

import { useState } from 'react';
import { FlaskConical, TrendingDown } from 'lucide-react';
import { api, isQueued } from '@/lib/api';
import { useToast } from '@/components/Toast';
import type { WhatIfResult, WhatIfScenario } from '@/lib/types';

/**
 * Ask a question about a station that does not exist yet.
 *
 * Everything on this console is already a projection — days of cover, a
 * readiness score. What an operator could not do was ask *if the ship slips
 * ten days, does the traverse still go?* without making the change for real
 * and undoing it, which puts a fiction into the audit log and into everyone
 * else's console.
 *
 * Nothing here writes. The result is labelled a projection everywhere it
 * appears, because a figure that does not say what it is gets read as a
 * reading.
 */

const PRESETS: Array<{ label: string; scenario: WhatIfScenario; hint: string }> = [
  { label: 'Ship slips 10 days',
    scenario: { cargo_delay_hours: 240, advance_days: 10 },
    hint: 'Every inbound consignment 10 days later, and 10 days of consumption' },
  { label: 'Traverse party arrives',
    scenario: { extra_crew: 6, advance_days: 7 },
    hint: 'Six more people on station for a week' },
  { label: 'Two-week whiteout',
    scenario: { delta_t: 30, advance_days: 14 },
    hint: 'A severe blizzard held for a fortnight' },
];

export function WhatIfPanel({ stationId, stationLabel }: {
  stationId: string;
  stationLabel: string;
}) {
  const { addToast } = useToast();
  const [scenario, setScenario] = useState<WhatIfScenario>({
    extra_crew: 0, cargo_delay_hours: 0, advance_days: 0, delta_t: null,
  });
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [running, setRunning] = useState(false);

  const run = async (next: WhatIfScenario) => {
    setScenario(next);
    setRunning(true);
    try {
      const projected = await api.whatIf(stationId, next);
      if (isQueued(projected)) {
        // The projection runs on the station. With the link down there is
        // nothing to project against, and a stale answer to a what-if is
        // worse than no answer.
        setResult(null);
        return addToast('The link is down, so this scenario cannot be scored. '
          + 'The figures it needs live on the station.', 'info');
      }
      setResult(projected);
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not score that scenario', 'alert');
    } finally { setRunning(false); }
  };

  const field = (key: keyof WhatIfScenario, label: string, suffix: string,
                 min: number, max: number) => (
    <div>
      <label htmlFor={`wi-${key}`} className="overline block mb-1">{label}</label>
      <div className="flex items-center gap-1.5">
        <input
          id={`wi-${key}`} type="number" min={min} max={max}
          value={(scenario[key] as number | null) ?? ''}
          placeholder="0"
          onChange={(e) => setScenario({
            ...scenario,
            [key]: e.target.value === '' ? (key === 'delta_t' ? null : 0)
              : Number(e.target.value),
          })}
          className="w-24 !py-1.5 !text-13 !min-h-0"
        />
        <span className="text-2xs text-frost-muted">{suffix}</span>
      </div>
    </div>
  );

  return (
    <div className="subview-card rounded-2xl p-5">
      <h2 className="text-base font-bold text-arctic-900 mb-1 flex items-center gap-2">
        <FlaskConical size={16} className="text-arctic-600" aria-hidden="true" />
        What if…
      </h2>
      <p className="text-xs text-frost-muted mb-4">
        Try a change against {stationLabel} without making it. Nothing is saved and
        nothing is written to the station log.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        {PRESETS.map((preset) => (
          <button key={preset.label} type="button" data-compact disabled={running}
                  title={preset.hint}
                  onClick={() => void run({ extra_crew: 0, cargo_delay_hours: 0,
                                            advance_days: 0, delta_t: null,
                                            ...preset.scenario })}
                  className="btn-secondary !min-h-0 !px-3 !py-1.5 text-2xs">
            {preset.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {field('extra_crew', 'Crew change', 'people', -200, 200)}
        {field('delta_t', 'Blizzard load', '°C', 0, 60)}
        {field('cargo_delay_hours', 'Cargo slips', 'hours', 0, 8760)}
        {field('advance_days', 'Look ahead', 'days', 0, 365)}
        <button type="button" disabled={running} onClick={() => void run(scenario)}
                className="btn-primary text-13 ml-auto">
          {running ? 'Scoring…' : 'Project'}
        </button>
      </div>

      {result && <WhatIfResultView result={result} />}
    </div>
  );
}

function WhatIfResultView({ result }: { result: WhatIfResult }) {
  // Only what the scenario actually moved. A table of unchanged rows buries
  // the two that matter.
  const moved = result.inventory
    .filter((i) => Math.abs(i.cover_change_days) >= 0.1)
    .sort((a, b) => a.cover_change_days - b.cover_change_days);
  const traverses = result.expeditions.filter((e) => e.readiness_change !== 0);

  return (
    <div className="mt-5 pt-4 border-t border-frost-border">
      <div className="flex items-center gap-2 mb-3">
        <span className="px-2 py-0.5 rounded border border-arctic-200 bg-arctic-50
                         text-arctic-800 font-mono text-2xs font-bold tracking-caps uppercase">
          Projection
        </span>
        <span className="text-2xs text-frost-muted">Nothing was saved.</span>
      </div>

      {/* The assumptions are half the answer. A number with no statement of
          what it took as given is one nobody should act on. */}
      <ul className="text-2xs text-frost-muted mb-4 space-y-0.5 list-disc list-inside">
        {result.assumptions.map((note) => <li key={note}>{note}</li>)}
      </ul>

      {moved.length === 0 && traverses.length === 0 ? (
        <p className="text-13 text-frost-muted">
          Nothing on this station moves under that scenario.
        </p>
      ) : (
        <div className="space-y-4">
          {moved.length > 0 && (
            <div>
              <span className="overline block mb-2">Days of cover</span>
              <ul className="space-y-1.5">
                {moved.map((item) => (
                  <li key={item.id}
                      className="flex items-center justify-between gap-3 text-13">
                    <span className="font-semibold text-arctic-900 truncate">
                      {item.name}
                      {item.newly_critical && (
                        <span className="ml-2 px-1.5 py-0.5 rounded border border-emergency-edge
                                         bg-emergency-tint text-emergency text-2xs font-bold">
                          would turn critical
                        </span>
                      )}
                    </span>
                    <span className="font-mono shrink-0">
                      <span className="text-frost-muted">
                        {item.before.days_of_cover.toFixed(1)}d
                      </span>
                      <span className="mx-1.5 text-frost-muted">→</span>
                      <span className={item.cover_change_days < 0
                        ? 'text-emergency font-bold' : 'text-nominal font-bold'}>
                        {item.after.days_of_cover.toFixed(1)}d
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {traverses.length > 0 && (
            <div>
              <span className="overline block mb-2">Traverse readiness</span>
              <ul className="space-y-1.5">
                {traverses.map((exp) => (
                  <li key={exp.id} className="text-13">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold text-arctic-900 truncate">{exp.name}</span>
                      <span className="font-mono shrink-0">
                        <span className="text-frost-muted">{exp.before_readiness}%</span>
                        <span className="mx-1.5 text-frost-muted">→</span>
                        <span className={exp.readiness_change < 0
                          ? 'text-emergency font-bold' : 'text-nominal font-bold'}>
                          {exp.after_readiness}%
                        </span>
                      </span>
                    </div>
                    {exp.newly_short.length > 0 && (
                      <p className="text-2xs text-emergency mt-0.5 flex items-center gap-1">
                        <TrendingDown size={11} aria-hidden="true" />
                        would fall short on {exp.newly_short.join(', ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
