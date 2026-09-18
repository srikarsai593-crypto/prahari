'use client';

import { useEffect, useState } from 'react';
import { offlineQueue } from '@/lib/offlineQueue';

export const ConnectivityPill = () => {
  const [offline, setOffline] = useState(offlineQueue.isOffline);
  const [pendingCount, setPendingCount] = useState(offlineQueue.pendingCount);

  useEffect(() => {
    const unsubscribe = offlineQueue.subscribe(() => {
      setOffline(offlineQueue.isOffline);
      setPendingCount(offlineQueue.pendingCount);
    });
    return unsubscribe;
  }, []);

  return (
    <div
      className={`glass-btn-pill flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs transition-all ${
        offline
          ? 'text-amber-800 border-amber-200 bg-amber-50/80'
          : 'text-emerald-800 border-emerald-200 bg-emerald-50/60'
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full ${
          offline ? 'bg-amber-500' : 'bg-emerald-500 status-badge-glow animate-pulse'
        }`}
      />
      <span className="font-medium tracking-wide text-[11px] font-display">
        {offline ? `Offline — ${pendingCount} pending` : 'Connected'}
      </span>
    </div>
  );
};
