import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";
import { WebSocketProvider } from "@/components/WebSocketProvider";
import { ToastProvider } from "@/components/Toast";
import { ConnectivityPill } from "@/components/ConnectivityPill";
import BlizzardCanvasLoader from "@/components/BlizzardCanvasLoader";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import 'leaflet/dist/leaflet.css';

export const metadata: Metadata = {
  title: "PRAHARI - Antarctic Operations Intelligence",
  description: "Antarctic Logistics & Safety Intelligence Platform",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/* Google Fonts loaded via <link> to avoid next/font build-time fetching */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Outfit:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <WebSocketProvider>
          <ToastProvider>
            {/* Blizzard particle canvas (pointer-events: none, fixed, z-15) */}
            <BlizzardCanvasLoader />

            {/* Alpine mist soft background overlay */}
            <div className="alpine-mist-bg" />

            {/* Wind layer */}
            <div className="blizzard-wind-layer">
              <div className="wind-drift" />
              <div className="wind-drift-fast" />
            </div>

            <div className="flex flex-col min-h-screen relative z-10">
              {/* ── Top Navigation ── */}
              <header className="w-full px-4 pt-4 pb-2 relative z-20">
                <nav className="nav-blur-bar max-w-[1400px] mx-auto rounded-2xl px-5 py-2.5 flex items-center justify-between">

                  {/* Brand */}
                  <Link href="/" className="flex items-center gap-3 group select-none">
                    <div className="w-9 h-9 rounded-xl bg-arctic-50 border border-arctic-200 flex items-center justify-center text-arctic-600 group-hover:scale-105 group-hover:bg-arctic-100 transition-all shadow-xs">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <line x1="12" x2="12" y1="2" y2="22" />
                        <line x1="2" x2="22" y1="12" y2="12" />
                        <line x1="4.93" x2="19.07" y1="4.93" y2="19.07" />
                        <line x1="19.07" x2="4.93" y1="4.93" y2="19.07" />
                        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                      </svg>
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-bold tracking-[0.14em] leading-none text-arctic-900" style={{ fontFamily: 'Outfit, sans-serif' }}>PRAHARI</span>
                        <span className="w-1.5 h-1.5 rounded-full bg-arctic-600" />
                      </div>
                      <p className="text-[10px] text-arctic-800/60 font-medium tracking-wider uppercase mt-0.5">
                        Antarctic Operations Intelligence
                      </p>
                    </div>
                  </Link>

                  {/* Nav links */}
                  <div className="hidden md:flex items-center space-x-0.5 text-[13px] font-medium">
                    {[
                      { href: '/expedition', label: 'Expedition' },
                      { href: '/cargo',      label: 'Cargo'      },
                      { href: '/inventory',  label: 'Inventory'  },
                      { href: '/personnel',  label: 'Personnel'  },
                      { href: '/emergency',  label: 'Emergency'  },
                    ].map(({ href, label }) => (
                      <Link
                        key={href}
                        href={href}
                        className="nav-btn-glass px-3.5 py-1.5 rounded-xl transition-all"
                      >
                        {label}
                      </Link>
                    ))}
                    <Link
                      href="/scenario"
                      className="glass-btn-pill ml-1 px-4 py-1.5 rounded-xl text-arctic-700 font-semibold transition-all"
                    >
                      Live Scenario
                    </Link>
                  </div>

                  {/* Right side: connectivity + station */}
                  <div className="flex items-center gap-3">
                    <ConnectivityPill />
                    <div className="glass-btn-pill px-3.5 py-1.5 rounded-xl text-xs font-bold text-arctic-900 tracking-wider">
                      36 OURS
                    </div>
                  </div>
                </nav>
              </header>

              {/* ── Page Content ── */}
              <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 py-5 md:py-8">
                <ErrorBoundary>
                  {children}
                </ErrorBoundary>
              </main>
            </div>
          </ToastProvider>
        </WebSocketProvider>
      </body>
    </html>
  );
}
