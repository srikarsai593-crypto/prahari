'use client';

import { useCallback, useState } from 'react';
import { Globe } from 'lucide-react';
import { AccessibilityDialog } from './AccessibilityStatement';

/**
 * The rail's language entry.
 *
 * GIGW 3.0 expects a government portal to name its language in the utility
 * rail, and this one did — as a `<span>` reading "English", sitting between
 * two controls that work. That is the same shape of defect the screen-reader
 * entry had before it: a label that looks like a control and is not one. An
 * operator who presses it learns nothing, and cannot tell whether the console
 * has one language or a switch that is broken.
 *
 * It does not become a switch, because there is nothing to switch to. Adding
 * a dropdown with one item in it, or a second language machine-translated
 * without a native reader, would both be worse than this: the first is still
 * a dead control, and the second claims a capability the console does not
 * have — the same thing the LLM chain refuses to do when it labels a regex
 * parse as a regex parse.
 *
 * So it says what is true and gives somewhere to read why. It is a real
 * button, it announces that it opens a dialog, and the dialog opens on the
 * line about language — which states the gap rather than apologising for it,
 * and names the two places another script could not reach even if the
 * interface were translated.
 */
export function LanguageNotice() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        type="button"
        data-compact
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title="This console is served in English only — what that covers, and why"
        className="flex items-center gap-1.5 uppercase tracking-caps
                   text-slate-300 hover:text-white transition-colors"
      >
        <Globe size={13} aria-hidden="true" />
        English
        {/*
          The visible label is the language, because that is what the rail is
          for and what somebody scanning it needs. What the control *does* is
          not "switch to English", so the accessible name says so — a screen
          reader user should not have to press it to find that out.
        */}
        <span className="sr-only">— language support on this console</span>
      </button>

      <AccessibilityDialog open={open} onClose={close} highlight="English only" />
    </>
  );
}
