import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: false,
  async rewrites() {
    return [
      // Proxy REST API calls
      {
        source: '/api/:path*',
        destination: 'http://localhost:8000/:path*',
      },
      // Proxy WebSocket connections
      {
        source: '/ws',
        destination: 'http://localhost:8000/ws',
      },
    ];
  },
};

export default nextConfig;
