import type { NextConfig } from 'next';

const backendUrl = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

/**
 * Content Security Policy for the console.
 *
 * 'unsafe-inline' on styles is required by Leaflet, which sets element styles
 * directly to position tiles and markers. Scripts do not get it: Next's inline
 * bootstrap is nonce-free in dev but hashed in production, and 'unsafe-eval'
 * is dev-only for React Refresh.
 */
const isDev = process.env.NODE_ENV !== 'production';

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  // OpenStreetMap raster tiles, and data: for the QR codes the backend returns
  // inline as base64.
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
  "font-src 'self' data:",
  // The API and the telemetry socket are same-origin via the rewrites below.
  // The service worker fetches map tiles itself, which the page's own
  // connect-src governs.
  `connect-src 'self' https://*.tile.openstreetmap.org${isDev ? ' ws: http:' : ' wss:'}`,
  // The offline cache runs as a service worker from this origin.
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    /*
     * Everything the console does not use stays denied, so an embedded
     * script cannot ask on its behalf.
     *
     * `camera=(self)` is the exception and it is load-bearing: the cargo
     * page and field mode both open the rear camera to read a crate label.
     * This header said `camera=()` — which was accurate when it was written
     * and became wrong the moment the scanner shipped, silently disabling
     * it for the whole origin in every browser. A policy listing a feature
     * the product now depends on is worse than no policy, because it fails
     * in a way that looks like a broken camera rather than a broken header.
     *
     * Geolocation stays denied on purpose. Field mode deliberately reports
     * the station's last known position for an SOS rather than prompting
     * for the handset's own — see the SOS screen for why.
     */
    value: 'geolocation=(), microphone=(), camera=(self), payment=(), usb=()',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: false,
  async headers() {
    return [
      // The worker script is excluded from the page policy and given its own.
      // A service worker runs in its own context, and the page's CSP
      // delivered with the script governs that context rather than the page
      // — so the page's directives are both wrong for it and, in some
      // browsers, enough to refuse the registration outright.
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Security-Policy',
            value: "default-src 'self'; connect-src 'self' "
              + 'https://*.tile.openstreetmap.org' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // The worker must not itself be cached, or a fix to the cache
          // cannot be deployed.
          { key: 'Cache-Control', value: 'no-cache' },
        ],
      },
      // Everything except the worker, which is handled above. Next appends
      // rather than replaces, so a catch-all of `/:path*` would put the
      // page policy back onto /sw.js alongside its own.
      { source: '/((?!sw\\.js$).*)', headers: securityHeaders },
    ];
  },
  async rewrites() {
    return [
      // Proxy REST API calls
      {
        source: '/api/:path*',
        destination: `${backendUrl}/:path*`,
      },
      // Proxy WebSocket connections
      {
        source: '/ws',
        destination: `${backendUrl}/ws`,
      },
    ];
  },
};

export default nextConfig;
