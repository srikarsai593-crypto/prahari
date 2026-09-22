'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useWebSocket } from './WebSocketProvider';
import type { AppEvent } from '@/lib/types';

export const EventTimeline = () => {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const { lastMessage } = useWebSocket();

  // Tick every 60s to force re-render of relative timestamps
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    api.listEvents(undefined, 20).then(data => {
      setEvents(Array.isArray(data) ? data : []);
    });
  }, []);

  useEffect(() => {
    if (lastMessage?.type === 'event' && lastMessage.data) {
      setEvents(prev => [lastMessage.data as AppEvent, ...prev].slice(0, 20));
    }
  }, [lastMessage]);

  const getModuleStyle = (module: string): { border: string; badge: string } => {
    switch (module) {
      case 'expedition': return { border: 'border-l-arctic-400',  badge: 'bg-arctic-50 text-arctic-700 border-arctic-200' };
      case 'cargo':      return { border: 'border-l-amber-400',   badge: 'bg-amber-50 text-amber-700 border-amber-200' };
      case 'inventory':  return { border: 'border-l-emerald-400', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
      case 'personnel':  return { border: 'border-l-violet-400',  badge: 'bg-violet-50 text-violet-700 border-violet-200' };
      case 'emergency':  return { border: 'border-l-rose-400',    badge: 'bg-rose-50 text-rose-700 border-rose-200' };
      default:           return { border: 'border-l-arctic-200',  badge: 'bg-arctic-50 text-arctic-600 border-arctic-200' };
    }
  };

  // Called every render — recalculates based on current Date.now() due to tick state
  const timeAgo = (dateStr: string) => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000));
    if (seconds < 60)   return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  return (
    <div className="subview-card rounded-2xl p-5 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-sm text-arctic-900 font-display flex items-center gap-2">
          ⏱️ Live Event Timeline
        </h3>
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
      </div>
      <div className="flex-1 overflow-y-auto pr-1 space-y-3 font-mono text-xs">
        {events.map(event => {
          const { border, badge } = getModuleStyle(event.module);
          return (
            <div key={event.id} className={`p-3 bg-arctic-50/60 border-l-4 ${border} rounded-r-xl border border-arctic-200 toast-enter`}>
              <div className="flex justify-between items-center text-[10px] text-frost-muted mb-1">
                <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${badge}`}>
                  {String(event.module || 'SYSTEM').toUpperCase()}
                </span>
                <span>{event.created_at ? timeAgo(event.created_at) : 'now'}</span>
              </div>
              <p className="text-arctic-900 font-medium leading-snug">{event.action}</p>
              {event.actor && <p className="text-[10px] text-frost-muted mt-0.5">by {event.actor}</p>}
            </div>
          );
        })}
        {events.length === 0 && (
          <div className="p-3 bg-arctic-50/60 border-l-4 border-l-emerald-500 rounded-r-xl border border-arctic-200">
            <div className="flex justify-between text-[10px] text-frost-muted mb-0.5">
              <span className="text-emerald-700 font-bold">SYSTEM BOOT</span>
              <span>now</span>
            </div>
            <p className="text-arctic-900 font-medium">PRAHARI Polar Kernel initialized. All station telemetry channels linked.</p>
          </div>
        )}
      </div>
    </div>
  );
};
