'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keyboard behaviour for a modal dialog.
 *
 * All four dialogs in the console handled Escape and nothing else, which
 * left three gaps a keyboard or screen-reader user meets immediately:
 *
 *   * **Focus never came back.** Closing dropped focus onto `<body>`, so an
 *     operator was returned to the top of the document and had to tab all
 *     the way back to the control they had just used.
 *   * **Two never took focus at all.** The dialog appeared and focus stayed
 *     on the page behind it — so the first Tab moved *within the page*, not
 *     within the modal.
 *   * **Tab walked out.** Nothing kept focus inside, so it was possible to
 *     tab into the page underneath while the overlay still covered it.
 *
 * Attach the returned ref to the element carrying `role="dialog"`.
 */

/** Everything a browser will let you tab to. */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDialogFocus<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void,
  /**
   * Where to put focus on close, when the element that opened the dialog
   * cannot be inferred.
   *
   * The default — whatever had focus when the dialog mounted — is wrong for
   * a trigger that disables itself while it works: the browser blurs a
   * control the moment it becomes disabled, so by the time the dialog
   * appears the "opener" is `<body>` and there is nothing to go back to.
   * The handover button does exactly that while it reads the station.
   */
  returnFocusTo?: RefObject<HTMLElement | null>,
) {
  const ref = useRef<T>(null);
  // Held in a ref so the effect does not re-run — and re-steal focus —
  // every time the parent re-renders with a new inline callback.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    const opener = returnFocusTo?.current
      ?? (document.activeElement as HTMLElement | null);
    /**
     * Deliberately not filtered on `offsetParent`: that is null for a
     * position:fixed element — which every one of these overlays is — and
     * null for everything under jsdom, which has no layout. The selector
     * already excludes disabled controls and `tabindex="-1"`; the rest is
     * the two ways a dialog actually hides a control.
     */
    const focusables = () => Array.from(
      ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    ).filter((el) => !el.hasAttribute('hidden') && !el.closest('[aria-hidden="true"]'));

    // Move focus in. The dialog itself is the fallback for a dialog with
    // nothing focusable in it, so focus is never left behind the overlay.
    const first = focusables()[0];
    if (first) first.focus();
    else { ref.current?.setAttribute('tabindex', '-1'); ref.current?.focus(); }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) { event.preventDefault(); return; }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      // Wrap at both ends rather than letting focus escape to the page.
      if (event.shiftKey && (active === firstItem || !ref.current?.contains(active))) {
        event.preventDefault(); lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault(); firstItem.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Put the operator back where they were. `isConnected` guards the
      // case where the opener itself was removed while the dialog was up.
      const target = returnFocusTo?.current ?? opener;
      if (target?.isConnected) target.focus();
    };
  }, [open]);

  return ref;
}
