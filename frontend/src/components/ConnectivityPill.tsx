'use client';

import { useEffect, useState } from 'react';
import { offlineQueue } from '@/lib/offlineQueue';
import { useWebSocket } from '@/components/WebSocketProvider';

export const ConnectivityPill = () => {
  const [offline, setOffline] = useState(offlineQueue.isOffline);
  const [pendingCount, setPendingCount] = useState(offlineQueue.pendingCount);
  const { isConnected } = useWebSocket();

  useEffect(() => {
    const unsubscribe = offlineQueue.subscribe(() => {
      setOffline(offlineQueue.isOffline);
      setPendingCount(offlineQueue.pendingCount);
    });
    return unsubscribe;
  }, []);

  // Determine pill state: network offline, WS disconnected, or fully connected
  const wsDown = !isConnected;
  const isFullyOffline = offline || wsDown;

  return (
    <div
      className={`glass-btn-pill flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs transition-all ${
        offline
          ? 'text-amber-800 border-amber-200 bg-amber-50/80'
          : wsDown
          ? 'text-orange-800 border-orange-200 bg-orange-50/80'
          : 'text-emerald-800 border-emerald-200 bg-emerald-50/60'
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full ${
          offline
            ? 'bg-amber-500'
            : wsDown
            ? 'bg-orange-400 animate-pulse'
            : 'bg-emerald-500 status-badge-glow animate-pulse'
        }`}
      />
      <span className="font-medium tracking-wide text-[11px] font-display">
        {offline
          ? `Offline — ${pendingCount} pending`
          : wsDown
          ? 'Reconnecting…'
          : 'Connected'}
      </span>
    </div>
  );
};
