'use client';

import { useCallback, useRef, useState } from 'react';
import { ClipboardCheck, Copy, Download, FileText, Loader2, Printer, X } from 'lucide-react';
import { useToast } from './Toast';
import { downloadTextFile } from '@/lib/download';
import { collectHandover, handoverFilename, renderHandover } from '@/lib/handover';
import { useDialogFocus } from '@/lib/useDialogFocus';

/**
 * "Generate shift handover brief".
 *
 * A polar station runs continuously; the console does not. Everything the
 * outgoing commander knows that is not written down goes to bed with them.
 *
 * The brief opens in a dialog rather than downloading straight to disk,
 * because reading it is the common case — the handover itself usually
 * happens over a desk, and only sometimes needs a file. Download, copy and
 * print are all offered from there.
 */
export function HandoverBriefButton({ station }: { station: string }) {
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState<{ text: string; at: Date } | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      const at = new Date();
      const sources = await collectHandover(station);
      setBrief({ text: renderHandover(sources, at), at });
      // Each source is allowed to fail on its own and the document says which
      // did. Surfacing it here too means the commander knows before they read.
      if (sources.unavailable.length > 0) {
        addToast(`Brief generated, but ${sources.unavailable.join(', ')} could not be `
          + 'read. Those sections are unknown, not empty.', 'warning');
      }
    } catch (cause) {
      addToast(cause instanceof Error ? cause.message : 'Could not generate the brief',
        'alert');
    } finally {
      setBusy(false);
    }
  };

  const close = useCallback(() => { setBrief(null); setCopied(false); }, []);

  // Escape, focus trap, and focus returned to the button on close. The
  // trigger is named explicitly because it disables itself while reading the
  // station, and a disabled control is blurred — so by the time the dialog
  // opens there is no "previously focused element" left to infer.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(brief !== null, close, triggerRef);

  const copy = async () => {
    if (!brief) return;
    try {
      await navigator.clipboard.writeText(brief.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access needs a secure context, which a station console on
      // plain HTTP over the LAN is not. The text is on screen and selectable.
      addToast('Could not reach the clipboard — select the text and copy it.', 'warning');
    }
  };

  const print = () => {
    if (!brief) return;
    const frame = document.createElement('iframe');
    // Printing the console itself would print the console. A detached frame
    // carrying only the text prints the document.
    frame.style.position = 'fixed';
    frame.style.right = '100%';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    if (!doc) { document.body.removeChild(frame); return; }
    const pre = doc.createElement('pre');
    pre.style.font = '11px/1.35 ui-monospace, Menlo, Consolas, monospace';
    pre.style.whiteSpace = 'pre-wrap';
    pre.textContent = brief.text;
    doc.body.appendChild(pre);
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    window.setTimeout(() => document.body.removeChild(frame), 1000);
  };

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => void generate()} disabled={busy}
              className="btn-secondary text-13 shrink-0">
        {busy
          ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          : <FileText size={14} aria-hidden="true" />}
        {busy ? 'Reading the station…' : 'Shift handover brief'}
      </button>

      {brief && (
        <div
          ref={dialogRef}
          className="fixed inset-0 z-[65] bg-arctic-950/30 backdrop-blur-sm flex items-center
                     justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Shift handover brief for ${station}`}
          onClick={(event) => { if (event.target === event.currentTarget) close(); }}
        >
          <div className="subview-card p-6 w-full max-w-4xl shadow-raised max-h-[92vh]
                          flex flex-col">
            <div className="flex items-start justify-between gap-3 mb-4 pb-4
                            border-b border-frost-border">
              <div>
                <span className="overline block">Shift handover · {station}</span>
                <h2 className="text-xl font-bold text-arctic-900 mt-1">Handover brief</h2>
                <p className="text-13 text-frost-muted mt-0.5">
                  A snapshot of the station as at{' '}
                  {brief.at.toISOString().slice(0, 16).replace('T', ' ')}Z. Read it to
                  the relief, or hand them the file.
                </p>
              </div>
              <button type="button" onClick={close} data-compact
                      aria-label="Close"
                      className="text-frost-muted hover:text-arctic-900 px-2 py-1 rounded-md
                                 hover:bg-frost-subtle transition-colors">
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <pre className="flex-1 overflow-auto rounded-md border border-frost-border
                            bg-frost-subtle p-4 font-mono text-2xs leading-relaxed
                            text-arctic-900 whitespace-pre">
              {brief.text}
            </pre>

            <div className="flex flex-wrap items-center gap-2 mt-4 pt-4
                            border-t border-frost-border">
              <button type="button" className="btn-primary text-13"
                      onClick={() => downloadTextFile(
                        handoverFilename(station, brief.at), brief.text)}>
                <Download size={14} aria-hidden="true" /> Download
              </button>
              <button type="button" className="btn-secondary text-13"
                      onClick={() => void copy()}>
                {copied
                  ? <ClipboardCheck size={14} aria-hidden="true" />
                  : <Copy size={14} aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" className="btn-secondary text-13" onClick={print}>
                <Printer size={14} aria-hidden="true" /> Print
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
