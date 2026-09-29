'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Play, X } from 'lucide-react';
import { TOUR_STEPS } from '@/lib/tourSteps';

/** Breathing room between the highlight and the element it is drawn around. */
const HALO = 8;
/** Gap between the highlight and the card that explains it. */
const GAP = 14;
const CARD_WIDTH = 348;
/** Keep the card clear of the viewport edge on a narrow screen. */
const MARGIN = 12;

interface Rect { top: number; left: number; width: number; height: number }

const measure = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
};

/**
 * A guided walk through the five things this console does that the others do
 * not.
 *
 * The problem this solves is not that the dashboard is unclear — it is that
 * somebody evaluating it has under a minute, and in that minute the most
 * unusual capability here (surviving a satellite outage) is a small toggle in
 * the corner of the navigation band. Nothing about the page directs anyone to
 * it. This does.
 *
 * It narrates rather than drives. No step presses a button, loads data or
 * changes a record on the visitor's behalf: the blackout stop explains the
 * drill and leaves the control lit, because a console that runs itself while
 * somebody watches is a video, and the point is that this one is real.
 */
export function DemoTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [mounted, setMounted] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  /** Where focus was before the tour took it, so it can be given back. */
  const opener = useRef<HTMLElement | null>(null);

  const step = TOUR_STEPS[index];
  const last = index === TOUR_STEPS.length - 1;

  // Portals need a DOM, and this renders on the server too.
  useEffect(() => { setMounted(true); }, []);

  const close = useCallback(() => {
    onClose();
    setIndex(0);
  }, [onClose]);

  useEffect(() => { if (open) setIndex(0); }, [open]);

  /*
   * Find and frame the step's anchor.
   *
   * Laid out before paint so the highlight never appears at the previous
   * step's position for a frame. The anchor is scrolled into view first and
   * then measured on the next frame, because a smooth scroll has not finished
   * — and often has not started — by the time scrollIntoView returns.
   */
  useLayoutEffect(() => {
    if (!open || !step) return;

    let frame = 0;
    const target = document.querySelector(`[data-tour="${step.target}"]`);

    // A step whose anchor is not on this screen still has something to say.
    // The navigation band is hidden below `md`, so the blackout stop has no
    // anchor on a handset; the card is simply centred instead of chasing an
    // element that is not there.
    if (!target) { setRect(null); return; }

    target.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto' : 'smooth',
    });

    /*
     * Follow the anchor rather than measuring it once.
     *
     * A single measurement is taken before the smooth scroll has moved
     * anything, so the highlight lands on empty page and stays there. Polling
     * each frame also covers the cases a scroll listener misses — the sticky
     * header resizing, a panel finishing its fetch and growing, the window
     * being dragged narrower mid-step.
     *
     * Only a genuine change is committed. Without the comparison this sets
     * state sixty times a second and re-renders the card continuously for as
     * long as the tour is open.
     */
    let shown: Rect | null = null;
    const track = () => {
      const next = measure(target);
      if (!shown
        || Math.abs(next.top - shown.top) > 0.5
        || Math.abs(next.left - shown.left) > 0.5
        || Math.abs(next.width - shown.width) > 0.5
        || Math.abs(next.height - shown.height) > 0.5) {
        shown = next;
        setRect(next);
      }
      frame = requestAnimationFrame(track);
    };
    frame = requestAnimationFrame(track);

    return () => cancelAnimationFrame(frame);
  }, [open, step]);

  // Take focus for the keyboard, and hand it back on the way out.
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    card?.focus();
    return () => { opener.current?.focus?.(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIndex((i) => (i < TOUR_STEPS.length - 1 ? i + 1 : i));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex((i) => (i > 0 ? i - 1 : i));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open || !mounted || !step) return null;

  // Below the anchor where there is room, above it otherwise, and centred
  // when there is no anchor at all.
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const below = rect ? rect.top + rect.height + HALO + GAP : 0;
  const placeAbove = rect ? below + 250 > vh && rect.top - GAP - HALO > 250 : false;

  const cardStyle: React.CSSProperties = rect
    ? {
      position: 'fixed',
      top: placeAbove ? undefined : below,
      bottom: placeAbove ? vh - (rect.top - HALO - GAP) : undefined,
      left: Math.min(
        Math.max(MARGIN, rect.left + rect.width / 2 - CARD_WIDTH / 2),
        Math.max(MARGIN, vw - CARD_WIDTH - MARGIN),
      ),
      width: Math.min(CARD_WIDTH, vw - MARGIN * 2),
    }
    : {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: Math.min(CARD_WIDTH, vw - MARGIN * 2),
    };

  return createPortal(
    <div className="tour-layer" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {/*
        The scrim is one enormous shadow cast outwards from the highlight, so
        the anchor stays at full brightness with no second element stacked
        over it. Clicking the dimmed area leaves the tour, which is what
        everyone tries first.
      */}
      <div
        className="tour-scrim"
        onClick={close}
        style={rect
          ? {
            top: rect.top - HALO,
            left: rect.left - HALO,
            width: rect.width + HALO * 2,
            height: rect.height + HALO * 2,
          }
          // No anchor: the shadow's source collapses to a point off-screen,
          // which leaves an evenly dimmed page behind the card.
          : { top: -9999, left: -9999, width: 0, height: 0 }}
      />

      <div
        ref={cardRef}
        tabIndex={-1}
        style={cardStyle}
        className="tour-card"
        // The scrim below this is a sibling, not an ancestor, but a click that
        // starts on the card must not reach it through the portal root.
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="font-mono text-2xs font-bold tracking-caps uppercase text-arctic-600">
            Step {index + 1} of {TOUR_STEPS.length}
          </span>
          <button
            type="button"
            data-compact
            onClick={close}
            aria-label="End the tour"
            className="shrink-0 -mt-1 -mr-1 p-1 rounded text-frost-muted hover:text-arctic-900
                       hover:bg-frost-subtle transition-colors"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <h2 id="tour-title" className="mt-1.5 text-15 font-bold text-arctic-900 leading-snug">
          {step.title}
        </h2>
        <p className="mt-2 text-13 leading-relaxed text-frost-muted">{step.body}</p>

        {step.action && (
          <p className="mt-3 px-3 py-2 rounded-md bg-alert-tint border border-alert-edge
                        text-2xs font-semibold text-alert leading-relaxed">
            {step.action}
          </p>
        )}

        {/* Progress, as dots rather than a bar: five is few enough to count,
            and a visitor deciding whether to keep going wants to know how
            many are left, not what fraction is done. */}
        <div className="mt-4 pt-3 border-t border-frost-border flex items-center
                        justify-between gap-3">
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {TOUR_STEPS.map((s, i) => (
              <span
                key={s.target}
                className={`h-1.5 rounded-full transition-all ${i === index
                  ? 'w-5 bg-arctic-600' : 'w-1.5 bg-frost-border'}`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {index > 0 && (
              <button type="button" data-compact onClick={() => setIndex((i) => i - 1)}
                      className="btn-secondary !py-1.5 !px-2.5 text-2xs">
                <ArrowLeft size={13} aria-hidden="true" />
                Back
              </button>
            )}
            <button
              type="button"
              data-compact
              onClick={() => (last ? close() : setIndex((i) => i + 1))}
              className="btn-primary !py-1.5 !px-3 text-2xs"
            >
              {last ? 'Finish' : 'Next'}
              {!last && <ArrowRight size={13} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The control that starts the tour, and the tour it starts. */
export function DemoTourButton({ className = 'btn-secondary text-13' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        <Play size={14} aria-hidden="true" className="fill-current" />
        Start demo tour
      </button>
      <DemoTour open={open} onClose={() => setOpen(false)} />
    </>
  );
}
