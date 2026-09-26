'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { offlineQueue } from '@/lib/offlineQueue';
import { useEffect, useState } from 'react';
import { NAV_LINKS, SCENARIO_LINK } from '@/lib/nav';
import { useWebSocket } from '@/components/WebSocketProvider';

/**
 * Tier 3 — the primary module navigation band.
 *
 * Dark navy so the tab row reads as the spine of the portal, with the active
 * module in a sky-blue container. The right-hand slot carries the SATCOM state,
 * which is the genuine WebSocket link status rather than decoration.
 */
export function PortalNav() {
  const pathname = usePathname();
  const { connected } = useWebSocket();
  const [pending, setPending] = useState(0);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const unsub = offlineQueue.subscribe(() => {
      setOffline(offlineQueue.isOffline);
      setPending(offlineQueue.pendingCount);
    });
    setOffline(offlineQueue.isOffline);
    setPending(offlineQueue.pendingCount);
    return unsub;
  }, []);

  // Whether the console can reach the station is not an optional decoration:
  // below xl this was hidden entirely, so an operator on a laptop had no way
  // to tell a live console from one queueing every write locally. The full
  // label collapses to the dot plus a short code, never to nothing.
  const link = offline
    ? { dot: 'bg-alert-fill', text: 'text-alert-fill',
        label: `QUEUED: ${pending} PENDING`, short: `Q${pending}` }
    : connected
      ? { dot: 'bg-nominal-fill status-badge-glow', text: 'text-nominal-fill',
          label: 'SATCOM: ONLINE', short: 'ON' }
      : { dot: 'bg-emergency-fill', text: 'text-emergency-fill',
          label: 'SATCOM: RECONNECTING', short: 'RECONN' };

  return (
    <nav className="portal-nav hidden md:block" aria-label="Operational modules">
      <div className="max-w-portal mx-auto px-4 flex items-center justify-between gap-4">
        {/* The tab row scrolls rather than clipping: at tablet widths the seven
            modules do not fit, and a half-cut tab reads as a rendering fault. */}
        <div className="flex items-center min-w-0 overflow-x-auto
                        [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {[...NAV_LINKS, SCENARIO_LINK].map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                data-compact
                className={`portal-tab ${active ? 'active' : ''}`}
              >
                <Icon size={16} aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </div>

        <div className={`flex items-center gap-2 font-mono text-xs font-bold
                         tracking-caps shrink-0 ${link.text}`}
             title={link.label}>
          <span className={`w-2 h-2 rounded-full shrink-0 ${link.dot}`} aria-hidden="true" />
          <span className="hidden xl:inline">{link.label}</span>
          <span className="xl:hidden">{link.short}</span>
          <span className="sr-only">Station link status: {link.label}</span>
        </div>
      </div>
    </nav>
  );
}
