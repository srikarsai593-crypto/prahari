import type { Metadata, Viewport } from 'next';
import { Outfit, JetBrains_Mono, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import 'leaflet/dist/leaflet.css';

import { WebSocketProvider } from '@/components/WebSocketProvider';
import { ConnectivityWatch } from '@/components/ConnectivityWatch';
import { SessionProvider } from '@/components/SessionProvider';
import { LoginGate } from '@/components/LoginGate';
import { StationProvider } from '@/components/StationProvider';
import { ToastProvider } from '@/components/Toast';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { CriticalBanner } from '@/components/CriticalBanner';
import { GovRail } from '@/components/GovRail';
import { PortalHeader } from '@/components/PortalHeader';
import { PortalNav } from '@/components/PortalNav';
import { NotamStrip } from '@/components/NotamStrip';
import { PortalFooter } from '@/components/PortalFooter';

// Self-hosted by next/font at build time — no runtime CDN call, which matters
// for a console that is expected to run on a station link that drops.
const outfit = Outfit({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800'],
  variable: '--font-outfit',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-jetbrains',
  display: 'swap',
});

// Telemetry display face — coordinates, ΔT readings, counts and every other
// figure an operator reads off the console. IBM Plex Mono has a wider aperture
// and unambiguous 0/O and 1/l than JetBrains Mono at small sizes, which is what
// a latitude has to survive. JetBrains Mono stays on IDs and code-like strings.
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'PRAHARI — National Antarctic Operations Intelligence & Logistics Portal | NCPOR, MoES',
  description:
    'Offline-first logistics and safety command centre for Indian polar research stations. '
    + 'Expedition planning, cargo tracking, inventory depletion, personnel routing and '
    + 'emergency accountability in one console.',
  // Installable: with the offline cache already in place, a console pinned to
  // a station laptop's home screen opens without a browser chrome and works
  // through an outage. The manifest is the only thing that was missing.
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'PRAHARI', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor: '#0f172a',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en"
          className={`${outfit.variable} ${jetbrains.variable} ${plexMono.variable}`}>
      <body>
        {/* Outside the sign-in gate on purpose: the offline cache has to be
            installed before it is needed, and an operator who reaches a
            signed-out console during an outage should still get the sign-in
            page rather than a browser error. No UI. */}
        <ConnectivityWatch />

        {/* Session first: the socket and every module below it are gated, so
            there is nothing for them to do until the operator is signed in. */}
        <SessionProvider>
          <LoginGate>
        <WebSocketProvider>
          <StationProvider>
            <ToastProvider>
              <a href="#main"
                 className="sr-only focus:not-sr-only focus:absolute focus:z-[90] focus:top-3
                            focus:left-3 focus:bg-white focus:text-arctic-900 focus:px-4
                            focus:py-2 focus:rounded-md focus:border focus:border-arctic-600">
                Skip to main content
              </a>

              <CriticalBanner />

              <div className="flex flex-col min-h-screen">
                <header className="relative z-30">
                  <GovRail />
                  <PortalHeader />
                  <PortalNav />
                  <NotamStrip />
                </header>

                <main id="main" className="flex-1 max-w-portal w-full mx-auto px-4 py-6">
                  <ErrorBoundary>{children}</ErrorBoundary>
                </main>

                <PortalFooter />
              </div>
            </ToastProvider>
          </StationProvider>
        </WebSocketProvider>
          </LoginGate>
        </SessionProvider>
      </body>
    </html>
  );
}
