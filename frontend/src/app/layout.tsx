import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { WebSocketProvider } from "@/components/WebSocketProvider";
import { ToastProvider } from "@/components/Toast";
import { ConnectivityPill } from "@/components/ConnectivityPill";
import 'leaflet/dist/leaflet.css';

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "PRAHARI - Antarctic Operations",
  description: "Antarctic Logistics & Safety Intelligence Platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <WebSocketProvider>
          <ToastProvider>
            <div className="flex flex-col min-h-screen">
              <header className="glass-card m-4 px-6 py-4 flex items-center justify-between rounded-2xl z-40 relative">
                <div className="flex items-center gap-4">
                  <div className="text-3xl">❄️</div>
                  <div>
                    <Link href="/">
                      <h1 className="text-2xl font-bold tracking-wider text-white">PRAHARI</h1>
                    </Link>
                    <p className="text-sm text-polar-300">Antarctic Operations Intelligence</p>
                  </div>
                </div>
                
                <nav className="flex gap-2">
                  <Link href="/expedition" className="px-4 py-2 rounded-lg hover:bg-polar-800 transition-colors text-polar-200 font-medium">Expedition</Link>
                  <Link href="/cargo" className="px-4 py-2 rounded-lg hover:bg-polar-800 transition-colors text-polar-200 font-medium">Cargo</Link>
                  <Link href="/inventory" className="px-4 py-2 rounded-lg hover:bg-polar-800 transition-colors text-polar-200 font-medium">Inventory</Link>
                  <Link href="/personnel" className="px-4 py-2 rounded-lg hover:bg-polar-800 transition-colors text-polar-200 font-medium">Personnel</Link>
                  <Link href="/emergency" className="px-4 py-2 rounded-lg hover:bg-polar-800 transition-colors text-polar-200 font-medium">Emergency</Link>
                  <Link href="/scenario" className="px-4 py-2 rounded-lg hover:bg-polar-800 transition-colors text-polar-200 font-medium border border-polar-600 bg-polar-800/50">Live Scenario</Link>
                </nav>

                <div className="flex items-center gap-6">
                  <ConnectivityPill />
                  <div className="text-sm font-bold bg-polar-700/50 px-3 py-1.5 rounded-lg border border-polar-600">
                    36 OURS
                  </div>
                </div>
              </header>
              <main className="flex-1 p-4 pt-0">
                {children}
              </main>
            </div>
          </ToastProvider>
        </WebSocketProvider>
      </body>
    </html>
  );
}
