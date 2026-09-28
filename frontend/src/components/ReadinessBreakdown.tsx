'use client';

import type { FeasibilityResult } from '@/lib/types';

/**
 * What actually drove a readiness score.
 *
 * The console reported a single percentage and the line items that were
 * short. Those are different questions: a traverse can be 62% ready with
 * nothing flagged short, and a commander deciding whether to authorise it
 * has no way to see that the figure is being held down by berths rather than
 * by fuel.
 *
 * The weights come from the station with the score. Hardcoding a second copy
 * here would drift from the backend's the first time either is tuned, and
 * then the contributions would stop adding up to the score printed beside
 * them — which is worse than not showing them at all.
 */

const LABELS: Record<string, string> = {
  personnel: 'Crew',
  inventory: 'Fuel & stores',
  mission: 'Inbound cargo',
  logistics: 'Berths',
};

export function ReadinessBreakdown({ result }: { result: FeasibilityResult }) {
  const weights = result.readiness_weights ?? {};
  const parts = Object.entries(result.readiness_breakdown ?? {})
    .map(([key, score]) => ({
      key,
      label: LABELS[key] ?? key,
      score,
      weight: weights[key] ?? 0,
      // What this factor put into the final number, in points out of 100.
      contribution: score * (weights[key] ?? 0),
    }))
    // Largest shortfall first: the thing holding the score down is what the
    // commander is deciding about.
    .sort((a, b) => (a.score - b.score) || (b.weight - a.weight));

  if (parts.length === 0) return null;

  const lost = (part: typeof parts[number]) => (100 - part.score) * part.weight;

  return (
    <div>
      <span className="overline block mb-2">What drives this score</span>
      <ul className="space-y-2">
        {parts.map((part) => (
          <li key={part.key}>
            <div className="flex items-baseline justify-between gap-2 text-2xs">
              <span className="font-semibold text-arctic-900">{part.label}</span>
              <span className="font-mono text-frost-muted">
                {part.score}% × {Math.round(part.weight * 100)}%
                {' = '}
                <span className="text-arctic-900 font-bold">
                  {part.contribution.toFixed(0)} pts
                </span>
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-frost-subtle overflow-hidden">
              {/* Width is the contribution against this factor's own ceiling,
                  so a full bar means "this factor is costing the score
                  nothing" rather than "this factor is large". */}
              <div
                className={`h-full rounded-full ${part.score >= 100 ? 'bg-nominal-fill'
                  : part.score >= 60 ? 'bg-alert-fill' : 'bg-emergency-fill'}`}
                style={{ width: `${Math.max(2, part.score)}%` }}
              />
            </div>
            {lost(part) >= 1 && (
              <p className="text-2xs text-frost-muted mt-0.5">
                Costing {lost(part).toFixed(0)} points.
              </p>
            )}
          </li>
        ))}
      </ul>
      <p className="text-2xs text-frost-muted mt-3">
        Each factor is scored out of 100 and weighted; the weighted points sum
        to the readiness figure above.
      </p>
    </div>
  );
}
