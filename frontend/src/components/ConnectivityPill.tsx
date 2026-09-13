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
    <div className="flex items-center gap-2 bg-polar-900/50 px-3 py-1.5 rounded-full border border-polar-700/50">
      <div className={`pulse-dot ${offline ? 'bg-danger' : 'bg-safe'}`}></div>
      <span className="text-sm font-medium text-polar-200">
        {offline ? `Offline - ${pendingCount} pending` : 'Connected'}
      </span>
    </div>
  );
};
