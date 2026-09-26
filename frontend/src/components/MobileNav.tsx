'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { NAV_LINKS, SCENARIO_LINK } from '@/lib/nav';
import { offlineQueue } from '@/lib/offlineQueue';
import { useWebSocket } from '@/components/WebSocketProvider';

/** Module navigation below the `md` breakpoint, where the tab band is hidden. */
export function MobileNav() {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();
  const { connected } = useWebSocket();
  const [pending, setPending] = useState(0);
  const [offline, setOffline] = useState(false);
  const links = [...NAV_LINKS, SCENARIO_LINK];

  // Navigating away must close the drawer — otherwise it stays open over the
  // page the operator just opened.
  useEffect(() => { setIsOpen(false); }, [pathname]);

  // The link state lives in the navigation band, which is hidden at this
  // width. Without it here, a phone or narrow window gave the operator no way
  // to tell a live console from one queueing every write locally.
  useEffect(() => {
    const sync = () => {
      setOffline(offlineQueue.isOffline);
      setPending(offlineQueue.pendingCount);
    };
    const unsub = offlineQueue.subscribe(sync);
    sync();
    return unsub;
  }, []);

  const link = offline
    ? { dot: 'bg-alert-fill', label: `${pending} write(s) queued locally` }
    : connected
      ? { dot: 'bg-nominal-fill', label: 'Station link up' }
      : { dot: 'bg-emergency-fill', label: 'Station link down — reconnecting' };

  return (
    <div className="md:hidden relative flex items-center gap-2 shrink-0">
      <span className="inline-flex items-center" title={link.label}>
        <span className={`w-2.5 h-2.5 rounded-full ${link.dot}`} aria-hidden="true" />
        <span className="sr-only">{link.label}</span>
      </span>
      <button
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
        aria-label={isOpen ? 'Close navigation menu' : 'Open navigation menu'}
        className="p-2 text-arctic-900 hover:bg-frost-subtle rounded-md transition-colors"
      >
        {isOpen ? <X size={24} aria-hidden="true" /> : <Menu size={24} aria-hidden="true" />}
      </button>

      {isOpen && (
        <nav aria-label="Operational modules"
             className="absolute top-full right-0 mt-2 w-64 bg-white border border-frost-border
                        rounded-md shadow-raised p-1.5 flex flex-col gap-0.5 z-50">
          {links.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 px-3.5 py-3 rounded-md text-sm font-semibold
                            transition-colors border-l-2
                            ${active
                              ? 'bg-arctic-100 text-arctic-800 border-l-arctic-600'
                              : 'text-arctic-900 border-l-transparent hover:bg-frost-subtle'}`}
              >
                <Icon size={18} aria-hidden="true" />
                {label}
              </Link>
            );
          })}

          <p className="mt-1 pt-2 border-t border-frost-border px-3.5 pb-1 flex items-center
                        gap-2 text-2xs font-mono tracking-caps uppercase text-frost-muted">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${link.dot}`}
                  aria-hidden="true" />
            {link.label}
          </p>
        </nav>
      )}
    </div>
  );
}
