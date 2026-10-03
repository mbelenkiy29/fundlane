import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { sampleRouteRedirects } from "./src/lib/mca/sample-route-redirects";
import { nextConfigHeaders } from "./src/lib/mca/security-headers";
import { SENTRY_TUNNEL_ROUTE } from "./src/lib/observability/sentry-options";

const nextConfig: NextConfig = {
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR || ".next",
  outputFileTracingRoot: process.cwd(),
  experimental: {
    optimizePackageImports: ["lucide-react", "@radix-ui/react-icons"],
    // Allow a 25 MB assistant upload plus multipart headers; routes enforce their own limits.
    proxyClientMaxBodySize: "26mb",
  },
  turbopack: { root: process.cwd() },

  // Image optimization
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'ui.shadcn.com',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
    ],
    formats: ['image/webp', 'image/avif'],
  },

  async headers() {
    return nextConfigHeaders();
  },

  // Redirects for better SEO
  async redirects() {
    return [
      {
        source: '/landing',
        destination: '/',
        permanent: true,
      },
      {
        source: '/home',
        destination: '/dashboard',
        permanent: true,
      },
      {
        source: '/dashboard-2',
        destination: '/dashboard',
        permanent: false,
      },
      {
        source: '/dashboard-2/:path*',
        destination: '/dashboard',
        permanent: false,
      },
      {
        source: '/deals/new',
        destination: '/pipeline?create=1',
        permanent: false,
      },
      ...sampleRouteRedirects,
    ];
  },
};

// Sentry is inert without NEXT_PUBLIC_SENTRY_DSN; source maps are generated and
// uploaded only when SENTRY_AUTH_TOKEN is set, then deleted from the deployment.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  // Same-origin tunnel (CSP connect-src 'self'); excluded from the proxy matcher in src/proxy.ts.
  tunnelRoute: SENTRY_TUNNEL_ROUTE,
  widenClientFileUpload: true,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN, deleteSourcemapsAfterUpload: true },
  errorHandler: (error) => {
    console.warn(`[sentry] Source map upload failed; continuing the build: ${error.message}`);
  },
});
