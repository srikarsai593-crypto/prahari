'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useStation } from '@/components/StationProvider';

/**
 * Standard module page header: breadcrumb trail, module title and code, the
 * station the page is reporting on, and a slot for page-level actions.
 *
 * Naming the active station here matters — every module is station-scoped, and
 * a page that silently reports on a different base than the header claims is
 * the kind of error an operator cannot see.
 */
export function PageHeader({
  title, code, description, children,
}: {
  title: string;
  code?: string;
  description?: string;
  children?: ReactNode;
}) {
  const { station, ready } = useStation();

  return (
    <div className="mb-6">
      <nav aria-label="Breadcrumb" className="breadcrumbs mb-3">
        <Link href="/">Dashboard</Link>
        <ChevronRight size={13} className="divider" aria-hidden="true" />
        <span aria-current="page">{title}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3 pb-4
                      border-b border-frost-border">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-[1.75rem] font-extrabold tracking-tight text-arctic-900
                           leading-tight">
              {title}
            </h1>
            {code && (
              <span data-compact
                    className="px-2.5 py-1 rounded border border-frost-border bg-frost-subtle
                               font-mono text-xs font-bold tracking-caps text-frost-muted">
                {code}
              </span>
            )}
            {/* Held blank until the persisted station is known, rather than
                asserting the default and flipping on hydration. */}
            <span data-compact
                  className="px-2.5 py-1 rounded-full border border-arctic-200 bg-arctic-100
                             font-mono text-xs font-bold tracking-caps uppercase
                             text-arctic-800 min-w-[7ch] text-center">
              {ready ? station.label : '\u00A0'}
            </span>
          </div>
          {description && (
            <p className="text-sm text-frost-muted mt-1.5 max-w-3xl">{description}</p>
          )}
        </div>

        {children && <div className="flex items-center gap-2 shrink-0">{children}</div>}
      </div>
    </div>
  );
}
