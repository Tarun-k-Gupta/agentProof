/**
 * The dashboard proxies the Verification API rather than calling it across an
 * origin.
 *
 * The session is an HttpOnly cookie, and a cross-origin request cannot carry
 * one without `Access-Control-Allow-Credentials` plus an exact origin echo —
 * which would mean the API maintaining an allowlist of dashboard origins and
 * getting it right. Same-origin through a rewrite costs one config block and
 * removes the entire question.
 */
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
