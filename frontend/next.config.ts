import type { NextConfig } from 'next';

const backendUrl = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

const nextConfig: NextConfig = {
  reactStrictMode: false,
  async rewrites() {
    return [
      // Proxy REST API calls
      {
        source: '/api/:path*',
        destination: `${backendUrl}/:path*`,
      },
      // Proxy WebSocket connections (for local dev)
      {
        source: '/ws',
        destination: `${backendUrl.replace(/^http/, 'ws')}/ws`,
      },
    ];
  },
};

export default nextConfig;
