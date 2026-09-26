import { publicPricingEnabled } from "@/lib/marketing/launch-switches"

/** Shared page title for the `/deals` nav item and funded-book heading. */
export const DEALS_PAGE_TITLE = "Deals"

/**
 * Marketing, auth, and tokenized public surfaces. Unknown paths are not listed
 * here — they must 404 instead of being treated as app routes.
 */
export const PUBLIC_PAGE_PREFIXES = [
  "/features",
  "/help",
  "/demo",
  "/privacy",
  "/terms",
  "/landing",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/accept-invite",
  "/verify-company",
  "/account-security",
  "/onboarding",
  "/errors",
  "/apply",
  "/merchant-upload",
  "/login",
  "/register",
] as const

/**
 * Real authenticated app pages. Dashboard, platform, and admin routes only.
 * API handlers are listed separately so they keep their own 401/403 responses.
 */
export const PROTECTED_APP_PREFIXES = [
  "/dashboard",
  "/dashboard-2",
  "/home",
  "/deals",
  "/pipeline",
  "/calendar",
  "/intake",
  "/applications",
  "/assistant",
  "/sms",
  "/mail",
  "/submissions",
  "/offers",
  "/advances",
  "/renewals",
  "/funders",
  "/payments",
  "/reports",
  "/settings",
  "/pricing",
  "/review",
  "/platform",
  "/admin",
] as const

export type AnonymousRequestDisposition = "public" | "sign-in" | "not-found" | "api"

function normalizePathname(pathname: string): string {
  if (!pathname) return "/"
  const path = pathname.split(/[?#]/, 1)[0] || "/"
  if (path === "/") return "/"
  return path.endsWith("/") ? path.slice(0, -1) || "/" : path
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function isApiPath(pathname: string): boolean {
  const path = normalizePathname(pathname)
  return path === "/api" || path.startsWith("/api/")
}

export function isPublicPagePath(pathname: string): boolean {
  const path = normalizePathname(pathname)
  if (path === "/") return true
  if (path === "/pricing" && publicPricingEnabled()) return true
  return PUBLIC_PAGE_PREFIXES.some((prefix) => matchesPrefix(path, prefix))
}

export function isProtectedAppPath(pathname: string): boolean {
  const path = normalizePathname(pathname)
  return PROTECTED_APP_PREFIXES.some((prefix) => matchesPrefix(path, prefix))
}

/** HTML sign-in redirect applies only to real app pages, never APIs or unknown URLs. */
export function requiresSignInRedirect(pathname: string): boolean {
  return anonymousRequestDisposition(pathname) === "sign-in"
}

export function anonymousRequestDisposition(pathname: string): AnonymousRequestDisposition {
  const path = normalizePathname(pathname)
  if (isApiPath(path)) return "api"
  if (isPublicPagePath(path)) return "public"
  if (isProtectedAppPath(path)) return "sign-in"
  return "not-found"
}

export type UnauthenticatedPageGate =
  | { action: "allow"; status: 200 }
  | { action: "sign-in"; status: 307; location: string }
  | { action: "not-found"; status: 404 }

/** Status and destination the dashboard auth gate uses for an anonymous visitor. */
export function unauthenticatedPageGate(pathname: string, returnTo?: string): UnauthenticatedPageGate {
  const disposition = anonymousRequestDisposition(pathname)
  if (disposition === "public" || disposition === "api") return { action: "allow", status: 200 }
  if (disposition === "sign-in") {
    return {
      action: "sign-in",
      status: 307,
      location: `/sign-in?returnTo=${encodeURIComponent(returnTo || pathname.split(/[?#]/, 1)[0] || "/dashboard")}`,
    }
  }
  return { action: "not-found", status: 404 }
}
