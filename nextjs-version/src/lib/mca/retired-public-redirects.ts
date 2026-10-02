/** Retired public marketing/auth URLs. Permanent redirects keep old bookmarks working. */
export const retiredPublicRedirects = [
  { source: "/demo", destination: "/", permanent: true },
  { source: "/demo/:path*", destination: "/", permanent: true },
  { source: "/sign-up", destination: "/", permanent: true },
  { source: "/sign-up/:path*", destination: "/", permanent: true },
  { source: "/register", destination: "/", permanent: true },
  { source: "/auth/sign-up", destination: "/", permanent: true },
] as const
