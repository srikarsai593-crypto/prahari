'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Minus, Volume2, X } from 'lucide-react';

/**
 * Screen reader and accessibility statement.
 *
 * GIGW 3.0 expects a government portal to carry a "Screen Reader Access"
 * entry in its utility rail, and this console did — as a `<span>` that did
 * nothing. That is the worst version of it: the support it names is real
 * (landmarks, a skip link, live regions on every alert, keyboard operation,
 * text scaling, a high-contrast theme), so a dead label sitting between two
 * controls that genuinely work reads as a control that is simply broken.
 *
 * So it is a real control now, and what it opens is a statement rather than
 * a claim: each line says what the console actually does, and the last
 * section says plainly what it does *not*. A portal that lists only its
 * successes is not an accessibility statement, it is marketing — and
 * somebody deciding whether they can use this console on a screen reader
 * needs the gaps more than the wins.
 */

interface Provision {
  supported: boolean;
  title: string;
  detail: string;
}

/**
 * Every line below was checked against the code, not aspirational. If one
 * stops being true, this list is wrong and should be corrected rather than
 * left standing.
 */
const PROVISIONS: Provision[] = [
  {
    supported: true,
    title: 'Skip to main content',
    detail: 'The first thing a keyboard reaches on every page, jumping the '
      + 'four bands of portal chrome straight to the module.',
  },
  {
    supported: true,
    title: 'Landmark regions',
    detail: 'Banner, navigation, search, main and contentinfo are real elements, '
      + 'so a screen reader can jump between them rather than reading linearly.',
  },
  {
    supported: true,
    title: 'Alerts are announced, not just shown',
    detail: 'Station-critical alerts are an assertive live region and interrupt; '
      + 'ordinary confirmations are polite and wait their turn. An operator who '
      + 'cannot see a toast is still told a write was queued rather than sent.',
  },
  {
    supported: true,
    title: 'Operable by keyboard throughout',
    detail: 'Every control is a real button, link or field. Dialogs take focus '
      + 'when they open and close on Escape.',
  },
  {
    supported: true,
    title: 'Text size',
    detail: 'A- / A / A+ in this rail scales the whole console, not just body '
      + 'copy — every size in the design system is relative. The choice persists.',
  },
  {
    supported: true,
    title: 'High contrast',
    detail: 'The Contrast toggle in this rail switches to a black canvas with '
      + 'maximum-contrast text and thickened borders. Every colour in it clears '
      + 'WCAG AA against its background.',
  },
  {
    supported: true,
    title: 'Figures are text, not images',
    detail: 'Every reading, count and coordinate on this console is selectable '
      + 'text. Nothing an operator has to act on is rendered into a picture.',
  },
  {
    supported: false,
    title: 'The maps are visual',
    detail: 'A Leaflet map is not meaningfully readable by a screen reader, and '
      + 'pretending otherwise would be worse than saying so. Everything plotted '
      + 'on one is also listed as text: crew positions on Personnel, consignments '
      + 'on Cargo, and an incident’s roll call in its accountability panel.',
  },
  {
    supported: false,
    title: 'No audio or sign-language alternatives',
    detail: 'The console carries no video or audio content, so none is provided. '
      + 'If that changes, this line has to change with it.',
  },
  {
    supported: false,
    title: 'English only',
    detail: 'The rail says English because that is all there is. Hindi has not '
      + 'been implemented, and the language control is not a switch.',
  },
];

/** Screen readers an operator is realistically going to have. Named, not
 *  bundled — no web page can supply one. */
const READERS = [
  ['NVDA', 'Windows, free and open source — nvaccess.org'],
  ['JAWS', 'Windows, commercial'],
  ['VoiceOver', 'Built into macOS and iOS — Cmd+F5, no install'],
  ['TalkBack', 'Built into Android'],
  ['Orca', 'Built into most Linux desktops'],
] as const;

export function AccessibilityStatement() {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        data-compact
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title="Screen reader and accessibility support on this console"
        className="hidden lg:flex items-center gap-1.5 uppercase tracking-caps
                   text-slate-300 hover:text-white transition-colors"
      >
        <Volume2 size={13} aria-hidden="true" />
        Screen Reader
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[70] bg-arctic-950/40 backdrop-blur-sm flex items-center
                     justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="a11y-heading"
          onClick={(event) => { if (event.target === event.currentTarget) close(); }}
        >
          <div className="subview-card p-6 w-full max-w-2xl shadow-raised max-h-[90vh]
                          flex flex-col text-left">
            <div className="flex items-start justify-between gap-3 mb-4 pb-4
                            border-b border-frost-border">
              <div>
                <span className="overline block">Accessibility</span>
                <h2 id="a11y-heading" className="text-xl font-bold text-arctic-900 mt-1">
                  Screen reader and accessibility
                </h2>
                <p className="text-13 text-frost-muted mt-1 normal-case tracking-normal">
                  What this console supports, and what it does not.
                </p>
              </div>
              <button ref={closeRef} type="button" onClick={close} data-compact
                      aria-label="Close"
                      className="text-frost-muted hover:text-arctic-900 px-2 py-1 rounded-md
                                 hover:bg-frost-subtle transition-colors shrink-0">
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto pr-1">
              <ul className="space-y-3">
                {PROVISIONS.map((item) => (
                  <li key={item.title} className="flex gap-3">
                    <span aria-hidden="true"
                          className={`shrink-0 mt-0.5 w-5 h-5 rounded-full grid place-items-center
                                      ${item.supported
                                        ? 'bg-nominal-tint text-nominal border border-nominal-edge'
                                        : 'bg-frost-subtle text-frost-muted '
                                          + 'border border-frost-border'}`}>
                      {item.supported
                        ? <Check size={12} strokeWidth={3} />
                        : <Minus size={12} strokeWidth={3} />}
                    </span>
                    <div className="min-w-0">
                      <p className="text-13 font-bold text-arctic-900 normal-case tracking-normal">
                        {item.title}
                        <span className="sr-only">
                          {item.supported ? ' — supported' : ' — not supported'}
                        </span>
                      </p>
                      <p className="text-13 text-frost-muted leading-relaxed normal-case
                                    tracking-normal">
                        {item.detail}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-6 pt-4 border-t border-frost-border">
                <h3 className="text-13 font-bold text-arctic-900 normal-case tracking-normal">
                  Using a screen reader
                </h3>
                <p className="text-13 text-frost-muted mt-1 leading-relaxed normal-case
                              tracking-normal">
                  Prahari does not supply one and no web page can. It is built to work
                  with the reader you already have:
                </p>
                <dl className="mt-3 space-y-1.5">
                  {READERS.map(([name, note]) => (
                    <div key={name} className="flex gap-2 text-13 normal-case tracking-normal">
                      <dt className="font-mono font-bold text-arctic-900 w-24 shrink-0">
                        {name}
                      </dt>
                      <dd className="text-frost-muted">{note}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
