'use client';

import Link from 'next/link';
import { NAV_LINKS, SCENARIO_LINK } from '@/lib/nav';
import { STATIONS } from '@/lib/stations';
import { Coordinate } from '@/components/Coordinate';

/**
 * Statutory footer — the dark plane that closes a government portal: module
 * index, policy column, and the coordinate/contact reference block.
 *
 * The station coordinates here are read from the same STATIONS table the map,
 * the compass and the backend geofences use, so the footer cannot drift out of
 * agreement with the rest of the console.
 */
/**
 * These were statutory policy titles that linked nowhere and described no
 * document this console serves — decoration shaped like compliance. They are
 * replaced by the operating facts an operator can verify from the console
 * itself.
 */
const OPERATING_NOTES = [
  'Everything the station needs is held here, not somewhere else.',
  'Changes made while the link is down are saved and sent when it returns.',
  'Stock figures are counted, never estimated.',
  'Every action is written to the station log with who did it and when.',
  'Anything filled in from a written request is a suggestion — confirm it.',
];

export function PortalFooter() {
  return (
    <footer className="bg-navy text-slate-300 mt-10">
      <div className="max-w-portal mx-auto px-4 py-10 grid grid-cols-1 md:grid-cols-2
                      lg:grid-cols-4 gap-8">
        {/* Identity */}
        <div>
          <div className="flex items-center gap-2.5 mb-3">
            <span className="text-xl font-extrabold tracking-tight text-white">PRAHARI</span>
            <span data-compact className="px-2 py-0.5 rounded bg-white/10 border border-white/20
                                          font-mono text-xs font-bold tracking-caps text-white">
              PORTAL
            </span>
          </div>
          <p className="text-13 leading-relaxed text-slate-400">
            National Polar Operational Intelligence Grid. Engineered for the Indian Antarctic
            Programme under the aegis of the Ministry of Earth Sciences (MoES), Government of India.
          </p>
          <p className="mt-4 font-mono text-xs leading-relaxed text-slate-400">
            <span className="text-slate-500">Nodal Agency:</span>{' '}
            <span className="text-white font-semibold">
              NCPOR, Headland Sada, Vasco da Gama, Goa – 403804
            </span>
          </p>
        </div>

        {/* Modules */}
        <nav aria-labelledby="footer-modules">
          <h2 id="footer-modules"
              className="font-mono text-xs font-bold tracking-caps text-white uppercase
                         pb-2 mb-3 border-b border-white/15">
            Station Modules
          </h2>
          <ul className="space-y-2.5 text-13">
            {[...NAV_LINKS, SCENARIO_LINK].map(({ href, label }) => (
              <li key={href}>
                <Link href={href} className="text-slate-400 hover:text-white transition-colors">
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <section aria-labelledby="footer-policies">
          <h2 id="footer-policies"
              className="font-mono text-xs font-bold tracking-caps text-white uppercase
                         pb-2 mb-3 border-b border-white/15">
            How This Console Behaves
          </h2>
          <ul className="space-y-2.5 text-13 text-slate-400">
            {OPERATING_NOTES.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </section>

        {/* Coordinates */}
        <section aria-labelledby="footer-coords">
          <h2 id="footer-coords"
              className="font-mono text-xs font-bold tracking-caps text-white uppercase
                         pb-2 mb-3 border-b border-white/15">
            Station Coordinates
          </h2>
          <ul className="space-y-2.5 font-mono text-xs leading-relaxed text-slate-400">
            {STATIONS.map((s) => (
              <li key={s.id}>
                <span className="text-white font-bold">{s.label}:</span>{' '}
                <Coordinate lat={s.lat} lng={s.lng} /> — {s.region}
              </li>
            ))}
            <li className="pt-1 text-slate-500">
              Positions are the published station coordinates and match the geofence
              table the tracker checks against.
            </li>
          </ul>
        </section>
      </div>

      <div className="border-t border-white/10">
        <div className="max-w-portal mx-auto px-4 py-5 flex flex-col sm:flex-row items-center
                        justify-between gap-3 text-xs text-slate-400">
          {/* min-w-0 on both: without it neither flex item can shrink and the
              copyright line overflows the container's own padding. */}
          <p className="min-w-0">
            © National Centre for Polar and Ocean Research (NCPOR), Ministry of Earth Sciences,
            Government of India.
          </p>
          {/* Conformance badges are claims about an audit that has not happened.
              What is true and useful is how this console behaves when the link
              drops, so that is what it says. */}
          <p className="min-w-0 font-mono tracking-caps flex flex-wrap items-center
                        justify-center gap-x-3 gap-y-1 shrink-0">
            <span>OFFLINE-FIRST STATION CONSOLE</span>
            <span className="text-slate-600" aria-hidden="true">|</span>
            <span>KEEPS WORKING WHEN THE LINK DROPS</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
