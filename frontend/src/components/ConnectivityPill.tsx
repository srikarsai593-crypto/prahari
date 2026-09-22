'use client';

import { useEffect, useState } from 'react';
import { offlineQueue } from '@/lib/offlineQueue';
import { useWebSocket } from '@/components/WebSocketProvider';

export const ConnectivityPill = () => {
  const { connected } = useWebSocket();
  const [pendingCount, setPendingCount] = useState(offlineQueue.pendingCount);
  const [offline, setOffline] = useState(offlineQueue.isOffline);

  useEffect(() => {
    const unsubscribe = offlineQueue.subscribe(() => {
      setOffline(offlineQueue.isOffline);
      setPendingCount(offlineQueue.pendingCount);
    });
    return unsubscribe;
  }, []);

  // Three states: manually offline (queue mode), WS disconnected, fully connected
  const isManualOffline = offline;
  const isWsDown = !connected && !offline;

  const dotColor = isManualOffline
    ? 'bg-amber-500'
    : isWsDown
    ? 'bg-rose-500'
    : 'bg-emerald-500 status-badge-glow animate-pulse';

  const pillColor = isManualOffline
    ? 'text-amber-800 border-amber-200 bg-amber-50/80'
    : isWsDown
    ? 'text-rose-800 border-rose-200 bg-rose-50/80'
    : 'text-emerald-800 border-emerald-200 bg-emerald-50/60';

  const label = isManualOffline
    ? `Offline — ${pendingCount} pending`
    : isWsDown
    ? 'Reconnecting...'
    : 'Live';

  return (
    <div className={`glass-btn-pill flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs transition-all ${pillColor}`}>
      <span className={`w-2 h-2 rounded-full ${dotColor}`} />
      <span className="font-medium tracking-wide text-[11px] font-display">{label}</span>
    </div>
  );
};
