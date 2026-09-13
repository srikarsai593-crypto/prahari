import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: false,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:8000/:path*',
      },
    ];
  },
};

export default nextConfig;
