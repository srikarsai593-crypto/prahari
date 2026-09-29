'use client';

import { useEffect, useState } from 'react';
import { Accessibility, Contrast } from 'lucide-react';
import { AccessibilityStatement } from './AccessibilityStatement';
import { LanguageNotice } from './LanguageNotice';
import { applyTheme, loadTheme, nextTheme, saveTheme, type Theme } from '@/lib/theme';

/**
 * Tier 1 — Government of India utility rail.
 *
 * The statutory strip every GIGW-compliant portal carries: issuing authority
 * chain, skip link, text-size controls, screen-reader affordance and language.
 *
 * The text-size buttons are real: they scale the root font size, which the whole
 * console is sized in rem/px-relative units against, and the choice persists.
 * So is the contrast toggle — see lib/theme.ts and the themed block at the
 * foot of globals.css.
 */
const SIZES = [
  { id: 'sm', label: 'A-', scale: 0.9, title: 'Decrease text size' },
  { id: 'md', label: 'A', scale: 1, title: 'Normal text size' },
  { id: 'lg', label: 'A+', scale: 1.12, title: 'Increase text size' },
] as const;

// Both keys are also read by the pre-paint script in app/layout.tsx, which
// runs before React and so cannot import them. Change either one in both
// places or the console flashes the previous setting on every load.
const STORAGE_KEY = 'prahari_text_scale';

export function GovRail() {
  const [size, setSize] = useState<(typeof SIZES)[number]['id']>('md');
  const [theme, setTheme] = useState<Theme>('standard');

  // Read once on mount rather than during render: the server has no
  // localStorage, and seeding state from it directly would hydrate-mismatch.
  useEffect(() => {
    const saved = loadTheme();
    setTheme(saved);
    applyTheme(saved);
  }, []);

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
          <span className="text-slate-400 shrink-0" aria-hidden="true">|</span>
          <span className="uppercase tracking-caps text-white shrink-0">Government of India</span>
          <span className="hidden md:inline text-slate-400" aria-hidden="true">|</span>
          <span className="hidden md:inline uppercase tracking-caps truncate">
            Ministry of Earth Sciences
          </span>
          <span className="hidden xl:inline text-slate-400" aria-hidden="true">|</span>
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

          {/* Not hidden on small screens, unlike the text-size group beside
              it: the handset is the device that goes outside, so this is
              exactly where the control is most needed. */}
          <button
            type="button"
            data-compact
            onClick={() => { const next = nextTheme(theme);
                             setTheme(next); applyTheme(next); saveTheme(next); }}
            aria-pressed={theme === 'contrast'}
            title="High-contrast display for glare and low vision"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border
                        uppercase tracking-caps text-2xs font-bold transition-colors
                        ${theme === 'contrast'
                          ? 'bg-arctic-600 border-arctic-600 text-white'
                          : 'border-slate-700 text-slate-300 hover:bg-white/10'}`}
          >
            <Contrast size={13} aria-hidden="true" />
            <span className="hidden sm:inline">Contrast</span>
            <span className="sr-only sm:hidden">
              {theme === 'contrast' ? 'Turn off high contrast' : 'Turn on high contrast'}
            </span>
          </button>

          <a href="#main"
             className="hidden lg:flex items-center gap-1.5 uppercase tracking-caps
                        hover:text-white transition-colors">
            <Accessibility size={13} aria-hidden="true" />
            Skip to content
          </a>

          {/* Was a <span> that did nothing, sitting between two controls
              that work. The support it names is real; see the component. */}
          <AccessibilityStatement />

          {/* Was a <span> reading "English" between two controls that work —
              the same defect the screen-reader entry had. It is not a switch,
              because there is nothing to switch to; see the component. */}
          <LanguageNotice />
        </div>
      </div>
    </div>
  );
}
