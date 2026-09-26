'use client';

import { useEffect, useState } from 'react';
import { Accessibility, Globe, Volume2 } from 'lucide-react';

/**
 * Tier 1 — Government of India utility rail.
 *
 * The statutory strip every GIGW-compliant portal carries: issuing authority
 * chain, skip link, text-size controls, screen-reader affordance and language.
 *
 * The text-size buttons are real: they scale the root font size, which the whole
 * console is sized in rem/px-relative units against, and the choice persists.
 */
const SIZES = [
  { id: 'sm', label: 'A-', scale: 0.9, title: 'Decrease text size' },
  { id: 'md', label: 'A', scale: 1, title: 'Normal text size' },
  { id: 'lg', label: 'A+', scale: 1.12, title: 'Increase text size' },
] as const;

const STORAGE_KEY = 'prahari_text_scale';

export function GovRail() {
  const [size, setSize] = useState<(typeof SIZES)[number]['id']>('md');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && SIZES.some((s) => s.id === saved)) {
        setSize(saved as (typeof SIZES)[number]['id']);
      }
    } catch { /* blocked storage — keep the default */ }
  }, []);

  useEffect(() => {
    const scale = SIZES.find((s) => s.id === size)?.scale ?? 1;
    document.documentElement.style.fontSize = `${16 * scale}px`;
    try { localStorage.setItem(STORAGE_KEY, size); } catch { /* non-fatal */ }
  }, [size]);

  return (
    <div className="gov-rail">
      <div className="max-w-portal mx-auto px-4 h-10 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0 overflow-hidden">
          <span className="flex items-center gap-2 shrink-0 text-white font-semibold">
            <span aria-hidden="true" className="text-13 leading-none">☬</span>
            <span className="hidden sm:inline">भारत सरकार</span>
          </span>
          <span className="text-slate-600 shrink-0" aria-hidden="true">|</span>
          <span className="uppercase tracking-caps text-white shrink-0">Government of India</span>
          <span className="hidden md:inline text-slate-600" aria-hidden="true">|</span>
          <span className="hidden md:inline uppercase tracking-caps truncate">
            Ministry of Earth Sciences
          </span>
          <span className="hidden xl:inline text-slate-600" aria-hidden="true">|</span>
          <span className="hidden xl:inline uppercase tracking-caps truncate text-slate-400">
            NCPOR · National Centre for Polar &amp; Ocean Research
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden sm:flex items-center gap-0.5 border border-slate-700 rounded-md
                          overflow-hidden" role="group" aria-label="Text size">
            {SIZES.map((s) => (
              <button
                key={s.id}
                type="button"
                data-compact
                title={s.title}
                aria-pressed={size === s.id}
                onClick={() => setSize(s.id)}
                className={`px-2.5 py-1 text-2xs font-bold transition-colors
                            ${size === s.id
                              ? 'bg-arctic-600 text-white'
                              : 'text-slate-300 hover:bg-white/10'}`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <a href="#main"
             className="hidden lg:flex items-center gap-1.5 uppercase tracking-caps
                        hover:text-white transition-colors">
            <Accessibility size={13} aria-hidden="true" />
            Skip to content
          </a>

          <span className="hidden lg:flex items-center gap-1.5 uppercase tracking-caps
                           text-slate-400">
            <Volume2 size={13} aria-hidden="true" />
            Screen Reader
          </span>

          <span className="flex items-center gap-1.5 uppercase tracking-caps text-slate-300">
            <Globe size={13} aria-hidden="true" />
            English
          </span>
        </div>
      </div>
    </div>
  );
}
