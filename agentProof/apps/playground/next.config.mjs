const API = process.env.AGENTPROOF_API_URL ?? 'http://127.0.0.1:8402';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${API}/v1/:path*` },
      { source: '/api/health', destination: `${API}/health` },
    ];
  },
};
