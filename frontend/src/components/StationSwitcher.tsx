'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { STATIONS, getStation } from '@/lib/stations';
import { Coordinate } from '@/components/Coordinate';

/**
 * Active-base selector, shown as a tactical badge beside the wordmark.
 *
 * The choice drives every station-scoped query in the console (via
 * StationProvider) and persists per browser.
 */
export function StationSwitcher({ value, onChange, ready = true }: {
  value: string;
  onChange: (id: string) => void;
  /** False until the persisted choice has been read on the client. */
  ready?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const active = getStation(value);

  // A menu that can only be dismissed by choosing something is a trap for
  // keyboard users — close on Escape and on an outside click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ready ? `Active station: ${active.label}. Change station.`
          : 'Reading the active station'}
        data-compact
        className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-arctic-200
                   bg-arctic-100 text-xs font-mono font-bold tracking-caps uppercase
                   text-arctic-800 hover:border-arctic-600 transition-colors"
      >
        {/* The server cannot know which station this browser last used, so
            it renders a placeholder of the same width rather than asserting
            the default — which then visibly flipped to the saved station on
            hydration. */}
        {ready ? active.label
          : <span className="inline-block w-20 h-3 rounded bg-arctic-200/70"
                  aria-hidden="true" />}
        <ChevronDown size={12} aria-hidden="true"
                     className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Active station"
          className="absolute left-0 mt-2 w-72 rounded-md bg-white border border-frost-border
                     shadow-raised py-1 z-50"
        >
          {STATIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={s.id === value}
              data-compact
              onClick={() => { onChange(s.id); setOpen(false); }}
              className={`w-full text-left px-3.5 py-2.5 transition-colors
                          hover:bg-frost-subtle border-l-2
                          ${s.id === value
                            ? 'border-l-arctic-600 bg-arctic-50'
                            : 'border-l-transparent'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-13 font-bold text-arctic-900">{s.label}</span>
                {s.id === value && (
                  <Check size={14} className="text-arctic-600 shrink-0" aria-hidden="true" />
                )}
              </div>
              <div className="text-2xs text-frost-muted mt-0.5 truncate">{s.region}</div>
              <div className="text-xs text-arctic-700 mt-0.5">
                <Coordinate lat={s.lat} lng={s.lng} />
                <span className="text-frost-muted font-mono"> · {s.capacity} berths</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
