'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Eye, LogOut, SatelliteDish } from 'lucide-react';
import { offlineQueue } from '@/lib/offlineQueue';
import { useEffect, useState } from 'react';
import { NAV_LINKS, SCENARIO_LINK } from '@/lib/nav';
import { useWebSocket } from '@/components/WebSocketProvider';
import { useSession } from '@/components/SessionProvider';
import { useToast } from '@/components/Toast';

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
  const { authenticated, isObserver, signOut } = useSession();
  const { addToast } = useToast();
  const [pending, setPending] = useState(0);
  const [offline, setOffline] = useState(false);
  const [blackout, setBlackout] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    const sync = () => {
      setOffline(offlineQueue.isOffline);
      setBlackout(offlineQueue.isBlackout);
      setPending(offlineQueue.pendingCount);
    };
    const unsub = offlineQueue.subscribe(sync);
    sync();
    return unsub;
  }, []);

  /**
   * Cut the station link, or restore it and replay what was written while it
   * was down. The claim this console makes is that an outage costs an operator
   * nothing, and until now there was no way to make it true in front of anyone
   * — you had to pull the network cable and hope.
   */
  const toggleBlackout = async () => {
    setSwitching(true);
    try {
      if (offlineQueue.isBlackout) {
        const held = offlineQueue.pendingCount;
        const { flushed, dropped } = await offlineQueue.setBlackout(false);
        addToast(
          held === 0
            ? 'SATCOM restored — nothing was written while the link was down'
            : `SATCOM restored — ${flushed} of ${held} queued write(s) replayed`
              + (dropped ? `, ${dropped} rejected` : ''),
          dropped ? 'warning' : 'success');
      } else {
        await offlineQueue.setBlackout(true);
        addToast('SATCOM blackout — writes are being held on this console and will '
          + 'replay when the link returns', 'warning');
      }
    } finally { setSwitching(false); }
  };

  // Whether the console can reach the station is not an optional decoration:
  // below xl this was hidden entirely, so an operator on a laptop had no way
  // to tell a live console from one queueing every write locally. The full
  // label collapses to the dot plus a short code, never to nothing.
  const link = blackout
    ? { dot: 'bg-alert-fill', text: 'text-alert-fill',
        label: `SATCOM: BLACKOUT (QUEUEING ${pending})`, short: `BLKT ${pending}` }
    : offline
      ? { dot: 'bg-alert-fill', text: 'text-alert-fill',
          label: `QUEUED: ${pending} PENDING`, short: `Q${pending}` }
      : connected
        ? { dot: 'bg-nominal-fill status-badge-glow', text: 'text-nominal-fill',
            label: 'SATCOM: LINK UP', short: 'UP' }
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

        <div className="flex items-center gap-3 shrink-0">
          <div className={`flex items-center gap-2 font-mono text-xs font-bold
                           tracking-caps ${link.text}`}
               title={link.label}>
            <span className={`w-2 h-2 rounded-full shrink-0 ${link.dot}`} aria-hidden="true" />
            <span className="hidden xl:inline">{link.label}</span>
            <span className="xl:hidden">{link.short}</span>
            <span className="sr-only">Station link status: {link.label}</span>
          </div>

          {/* Proving the offline claim needs a way to sever the link on demand.
              Labelled a simulation everywhere it appears, so the amber badge
              beside it is never mistaken for a real satellite failure. */}
          <button
            type="button"
            data-compact
            role="switch"
            aria-checked={blackout}
            disabled={switching}
            onClick={() => void toggleBlackout()}
            title={blackout
              ? 'Restore the simulated link and replay everything queued'
              : 'Simulate losing the satellite link — writes queue on this console'}
            className={`flex items-center gap-1.5 font-mono text-2xs font-bold tracking-caps
                        uppercase border rounded px-2 py-1 transition-colors
                        ${blackout
                          ? 'border-alert-edge bg-alert-tint text-alert'
                          : 'border-frost-border text-frost-muted hover:text-arctic-100 '
                            + 'hover:border-arctic-600'}`}
          >
            <SatelliteDish size={12} aria-hidden="true" />
            <span className="hidden xl:inline">
              {blackout ? 'Restore link' : 'Simulate blackout'}
            </span>
          </button>

          {/* Standing, not a toast: an observer needs to know why a control
              refused them at the moment they press it, which may be twenty
              minutes after they arrived. */}
          {isObserver && (
            <span data-compact
                  title="Read-only session. Sign in with the commander key to make changes."
                  className="flex items-center gap-1.5 px-2 py-1 rounded border
                             border-alert-edge bg-alert-tint text-alert font-mono text-2xs
                             font-bold tracking-caps uppercase">
              <Eye size={12} aria-hidden="true" />
              <span className="hidden lg:inline">Read only</span>
            </span>
          )}

          {/* A console left signed in on a shared terminal is the other half
              of taking the key out of the bundle.

              Set in the band's own sentence case rather than as a monospace
              caps badge: it is an ordinary account action, and three uppercase
              mono items in a row made the link status, the blackout drill and
              this read as one alarm cluster. It does not go red on hover
              either — signing out is routine, and red is the colour this
              console uses for an emergency. */}
          {authenticated && (
            <button
              type="button"
              data-compact
              onClick={() => void signOut()}
              title="End this station session"
              className="flex items-center gap-1.5 text-13 text-slate-400
                         hover:text-white transition-colors
                         border-l border-white/15 pl-3"
            >
              <LogOut size={13} aria-hidden="true" />
              <span className="hidden lg:inline">Sign out</span>
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
