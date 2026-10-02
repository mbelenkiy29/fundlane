import type { NextConfig } from "next";
import { sampleRouteRedirects } from "./src/lib/mca/sample-route-redirects";
import { nextConfigHeaders } from "./src/lib/mca/security-headers";

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
        source: '/',
        has: [{ type: 'host', value: 'app.fundlane.io' }],
        destination: '/dashboard',
        permanent: false,
      },
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

export default nextConfig;
