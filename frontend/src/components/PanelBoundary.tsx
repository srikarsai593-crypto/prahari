'use client';

import React from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

interface Props {
  /** What failed, in the operator's words: "the map", "the timeline". */
  label: string;
  children: React.ReactNode;
  /** Rendered instead of the default notice, for a panel too small for it. */
  compact?: boolean;
}

interface State {
  error: Error | null;
}

/**
 * A boundary around one panel rather than the whole page.
 *
 * The page-level boundary is the wrong granularity for a console used during
 * an incident: a Leaflet tile error takes the accountability head-count and
 * the resolve button down with the map, and an operator loses the two things
 * they actually needed because a third thing failed. Each panel that can fail
 * independently is wrapped so the rest of the module keeps working.
 *
 * Deliberately not a retry loop — a component that threw once will usually
 * throw again on the same data, and a boundary that remounts it automatically
 * turns one failure into a flickering page.
 */
export class PanelBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[${this.props.label}] panel failed:`, error, info);
  }

  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.compact) {
      return (
        <div role="alert"
             className="flex items-center justify-between gap-2 rounded-xl border
                        border-amber-200 bg-amber-50/70 px-3 py-2">
          <span className="flex items-center gap-1.5 text-2xs text-amber-900">
            <AlertTriangle size={12} aria-hidden="true" />
            {this.props.label} could not be shown
          </span>
          <button type="button" data-compact onClick={this.retry}
                  className="text-2xs font-mono uppercase tracking-caps text-amber-900
                             hover:underline">
            Retry
          </button>
        </div>
      );
    }

    return (
      <div role="alert"
           className="h-full min-h-[200px] flex items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <span className="w-10 h-10 rounded-full bg-amber-50 border border-amber-200
                           flex items-center justify-center mx-auto mb-3">
            <AlertTriangle size={18} className="text-amber-600" aria-hidden="true" />
          </span>
          <h3 className="font-bold text-arctic-900 text-13">
            {this.props.label} could not be shown
          </h3>
          <p className="text-2xs text-frost-muted mt-1.5 leading-relaxed">
            The rest of this page is unaffected and the station&apos;s records are intact.
          </p>
          {error.message && (
            <details className="text-left mt-3">
              <summary className="text-2xs text-frost-muted cursor-pointer
                                  hover:text-arctic-800">
                Technical detail
              </summary>
              <p className="text-2xs text-frost-muted font-mono mt-1.5 break-words">
                {error.message}
              </p>
            </details>
          )}
          <button type="button" onClick={this.retry}
                  className="btn-secondary text-2xs mt-4 !px-3 !py-1.5 !min-h-0">
            <RotateCw size={12} aria-hidden="true" /> Retry
          </button>
        </div>
      </div>
    );
  }
}
