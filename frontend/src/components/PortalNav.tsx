'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Eye, LogIn, LogOut, SatelliteDish } from 'lucide-react';
import { useState } from 'react';
import { useBlackoutDrill } from '@/lib/useBlackoutDrill';
import { SignInDialog } from '@/components/SignInDialog';
import { NAV_LINKS, SCENARIO_LINK } from '@/lib/nav';
import { useWebSocket } from '@/components/WebSocketProvider';
import { useSession } from '@/components/SessionProvider';

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
  const { authenticated, canWrite, isObserver, signOut } = useSession();
  const [signingIn, setSigningIn] = useState(false);
  const { pending, offline, blackout, switching, toggle } = useBlackoutDrill();

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
            onClick={() => void toggle()}
            title={blackout
              ? 'Restore the simulated link and replay everything queued'
              : 'Simulate losing the satellite link — writes queue on this console'}
            data-tour="blackout"
            className={`flex items-center gap-1.5 font-mono text-2xs font-bold tracking-caps
                        uppercase border rounded px-2 py-1 transition-colors
                        ${blackout
                          ? 'border-alert-edge bg-alert-tint text-alert blackout-switch-live'
                          : 'border-frost-border text-slate-300 hover:text-white '
                            + 'hover:border-arctic-600'}`}
          >
            <SatelliteDish size={12} aria-hidden="true" />
            <span className="hidden xl:inline">
              {blackout ? 'Restore link' : 'Simulate blackout'}
            </span>
          </button>

          {/* Standing, not a toast: someone who cannot write needs to know why
              a control refused them at the moment they press it, which may be
              twenty minutes after they arrived.

              Keyed on `canWrite` rather than on the observer role. A station
              serving open reads hands anonymous visitors a console that looks
              complete and refuses every write, and they are not observers —
              they have no session at all — so the badge that explains it never
              appeared for the one group with no way to work out why. */}
          {!canWrite && (
            <span data-compact
                  title={isObserver
                    ? 'Read-only session. Sign in with the commander key to make changes.'
                    : 'Reading without a session. Sign in to make changes.'}
                  className="flex items-center gap-1.5 px-2 py-1 rounded border
                             border-alert-edge bg-alert-tint text-alert font-mono text-2xs
                             font-bold tracking-caps uppercase">
              <Eye size={12} aria-hidden="true" />
              <span className="hidden lg:inline">Read only</span>
            </span>
          )}

          {/* Where reads are open there is no wall, so this is the only way in.
              Without it the console shows an anonymous visitor everything and
              then refuses every control, with nothing on the page to press. */}
          {!authenticated && (
            <button
              type="button"
              data-compact
              onClick={() => setSigningIn(true)}
              title="Sign in with the station commander key"
              className="flex items-center gap-1.5 text-13 text-slate-300
                         hover:text-white transition-colors
                         border-l border-white/15 pl-3"
            >
              <LogIn size={13} aria-hidden="true" />
              <span className="hidden lg:inline">Sign in</span>
            </button>
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

      <SignInDialog open={signingIn} onClose={() => setSigningIn(false)} />
    </nav>
  );
}
