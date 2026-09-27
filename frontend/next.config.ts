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
  `connect-src 'self'${isDev ? ' ws: http:' : ' wss: https:'}`,
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
    // The console asks for none of these; saying so stops an embedded script
    // from asking on its behalf.
    value: 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
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
