'use client';

import { useState } from 'react';
import { DatabaseZap } from 'lucide-react';
import { api, isQueued, queuedMessage } from '@/lib/api';
import { useToast } from '@/components/Toast';

/**
 * Puts a mid-season operational picture on all three stations.
 *
 * The station seed establishes crew, stock and geofences but no consignments,
 * traverses or incidents, because those are what an exercise creates and what
 * a reset clears. The consequence is that a console opened for the first time
 * shows an empty Cargo board and an empty Emergency page, which is
 * indistinguishable from a backend that is down. This is the one click that
 * fixes that.
 *
 * It is destructive in the same way the reset beside it is — it restores the
 * baseline before planting anything, or a second click would double every
 * consignment — so it confirms first.
 */
export function DemoSeasonButton({ onLoaded, className = 'btn-secondary text-13' }: {
  /** Called after a successful load, so the caller can refresh its own data. */
  onLoaded?: () => void;
  className?: string;
}) {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!window.confirm(
      'Load the demonstration season?\n\n'
      + 'This first clears every expedition, consignment, incident and movement plan '
      + 'across all three stations, then plants a set of synthetic records so each '
      + 'module has something to show. It cannot be undone.')) return;

    setLoading(true);
    try {
      const result = await api.loadDemoSeason();
      // A queued call resolves to the marker, not to a season: reading
      // `created.shipments` off it throws, so the control reports a crash
      // where it should report that the station has not been asked yet.
      if (isQueued(result)) {
        return addToast(queuedMessage('Loading the demonstration season'), 'info');
      }
      const { created } = result;
      addToast(`Demonstration season loaded — ${created.shipments} consignment(s), `
        + `${created.expeditions} traverse(s) and ${created.incidents} closed incident(s) `
        + 'across all three stations', 'success');
      onLoaded?.();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not load the season', 'alert');
    } finally { setLoading(false); }
  };

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={loading}
      title="Clear operational records and plant a synthetic season on all three stations"
      className={className}
    >
      <DatabaseZap size={14} aria-hidden="true" />
      {loading ? 'Loading…' : 'Load demo season'}
    </button>
  );
}
