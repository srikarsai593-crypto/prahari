'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useWebSocket } from './WebSocketProvider';

export const EventTimeline = () => {
  const [events, setEvents] = useState<any[]>([]);
  const { lastMessage } = useWebSocket();

  useEffect(() => {
    api.listEvents(undefined, 20).then(data => {
      setEvents(Array.isArray(data) ? data : []);
    });
  }, []);

  useEffect(() => {
    if (lastMessage?.type === 'event' && lastMessage.data) {
      setEvents(prev => [lastMessage.data, ...prev].slice(0, 20));
    }
  }, [lastMessage]);

  const getModuleColor = (module: string) => {
    switch (module) {
      case 'expedition': return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
      case 'cargo': return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
      case 'inventory': return 'bg-green-500/20 text-green-400 border-green-500/30';
      case 'personnel': return 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30';
      case 'emergency': return 'bg-red-500/20 text-red-400 border-red-500/30';
      default: return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
    }
  };

  const timeAgo = (dateStr: string) => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  };

  return (
    <div className="glass-card p-4 h-full flex flex-col">
      <h3 className="font-bold text-lg mb-4 text-white">Event Timeline</h3>
      <div className="flex-1 overflow-y-auto pr-2 space-y-4">
        {events.map(event => (
          <div key={event.id} className="relative pl-4 border-l-2 border-polar-700/30 toast-enter">
            <div className="absolute -left-[9px] top-1.5 w-4 h-4 rounded-full bg-polar-900 border-2 border-polar-600"></div>
            <div className="flex justify-between items-start mb-1">
              <span className={`text-xs px-2 py-0.5 rounded-full border ${getModuleColor(event.module)}`}>
                {String(event.module || 'system').toUpperCase()}
              </span>
              <span className="text-xs text-polar-400">{event.created_at ? timeAgo(event.created_at) : 'now'}</span>
            </div>
            <p className="text-sm text-polar-100">{event.action}</p>
            {event.actor && <p className="text-xs text-polar-500 mt-1">by {event.actor}</p>}
          </div>
        ))}
        {events.length === 0 && <p className="text-polar-400 text-sm">No events yet.</p>}
      </div>
    </div>
  );
};
