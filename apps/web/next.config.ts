import path from 'node:path';
import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig: NextConfig = {
  agentRules: false,
  // Docker builds set NEXT_STANDALONE=1. Local `next start` does not support standalone output.
  ...(process.env.NEXT_STANDALONE === '1'
    ? { output: 'standalone' as const, outputFileTracingRoot: path.join(__dirname, '../..') }
    : {}),
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
