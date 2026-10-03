/** Removed ShadcnStore template screens. Destinations are live product routes only. */
export const sampleRouteRedirects = [
  { source: "/sign-in-2", destination: "/sign-in", permanent: true },
  { source: "/sign-in-3", destination: "/sign-in", permanent: true },
  { source: "/sign-up-2", destination: "/", permanent: true },
  { source: "/sign-up-3", destination: "/", permanent: true },
  { source: "/forgot-password-2", destination: "/forgot-password", permanent: true },
  { source: "/forgot-password-3", destination: "/forgot-password", permanent: true },
  { source: "/auth/sign-in-2", destination: "/sign-in", permanent: true },
  { source: "/auth/sign-in-3", destination: "/sign-in", permanent: true },
  { source: "/auth/sign-up-2", destination: "/", permanent: true },
  { source: "/auth/sign-up-3", destination: "/", permanent: true },
  { source: "/auth/forgot-password-2", destination: "/forgot-password", permanent: true },
  { source: "/auth/forgot-password-3", destination: "/forgot-password", permanent: true },
  { source: "/users", destination: "/settings/team", permanent: true },
  { source: "/tasks", destination: "/dashboard", permanent: true },
  { source: "/chat", destination: "/assistant", permanent: true },
  { source: "/faqs", destination: "/", permanent: true },
] as const
