'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { StockoutForecast } from '@/lib/types';

/**
 * How soon this row could bite, beside how soon it will at today's rate.
 *
 * `days_of_cover` is the straight line. It is the right figure to lead with
 * and it is silent about the thing a commander actually decides: whether to
 * wait for the tanker window or act now. Thirty days at a steady rate and
 * thirty at a rate that swings by four are different propositions.
 *
 * Shows nothing at all when the station has not consumed the row often
 * enough to have a distribution — a band drawn from three numbers looks
 * exactly as authoritative as one drawn from thirty, which is the failure
 * mode worth avoiding.
 */
export function StockoutBand({ stationId, itemId }: { stationId: string; itemId: string }) {
  const [forecast, setForecast] = useState<StockoutForecast | null>(null);
  const [method, setMethod] = useState<string>('');

  useEffect(() => {
    let live = true;
    api.stockoutRisk(stationId)
      .then((risk) => {
        if (!live) return;
        setMethod(risk.method);
        setForecast(risk.items.find((i) => i.id === itemId)?.forecast ?? null);
      })
      .catch(() => { if (live) setForecast(null); });
    return () => { live = false; };
  }, [stationId, itemId]);

  if (!forecast) return null;

  if (!forecast.available) {
    return (
      <div className="mt-3 pt-3 border-t border-frost-border">
        <span className="overline block">Stockout risk</span>
        <p className="text-2xs text-frost-muted mt-1">
          Not enough recorded consumption to put a range on this yet
          {forecast.observed_days > 0 && ` (${forecast.observed_days} day(s) so far)`}.
          The figure above is the straight-line estimate.
        </p>
      </div>
    );
  }

  const soon = forecast.p10_days;
  const likely = forecast.p50_days;

  return (
    <div className="mt-3 pt-3 border-t border-frost-border">
      <span className="overline block">Stockout risk</span>
      {likely == null ? (
        <p className="text-13 text-nominal font-semibold mt-1">
          Holds past {forecast.horizon_days} days in every run.
        </p>
      ) : (
        <>
          <p className="metric text-arctic-900 mt-1">
            {soon === likely
              ? `${likely} days`
              : `${soon}–${likely} days`}
          </p>
          <p className="text-2xs text-frost-muted mt-0.5">
            Soonest realistic to most likely, over {forecast.trials} runs on this
            station&apos;s own history
            {forecast.survived_horizon_pct != null && forecast.survived_horizon_pct > 0
              && ` · lasts past ${forecast.horizon_days}d in `
                 + `${forecast.survived_horizon_pct}% of them`}.
          </p>
        </>
      )}
      {forecast.spread && (
        <p className="text-2xs text-frost-muted mt-1 font-mono">
          Observed daily use {forecast.spread.low}–{forecast.spread.high}
          {' '}(median {forecast.spread.median}) over {forecast.observed_days} days
        </p>
      )}
      {/* A percentile with no method behind it is a number people over-read. */}
      {method && <p className="text-2xs text-frost-muted mt-1 italic">{method}</p>}
    </div>
  );
}
