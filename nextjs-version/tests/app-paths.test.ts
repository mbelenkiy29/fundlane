import test from "node:test"
import assert from "node:assert/strict"
import {
  DEALS_PAGE_TITLE,
  PUBLIC_PAGE_PREFIXES,
  PROTECTED_APP_PREFIXES,
  anonymousRequestDisposition,
  isPublicPagePath,
  isProtectedAppPath,
  requiresSignInRedirect,
} from "../src/lib/mca/app-paths"

test("Deals is the shared nav and page title", () => {
  assert.equal(DEALS_PAGE_TITLE, "Deals")
})

test("public marketing and auth pages stay public while logged out", () => {
  for (const path of [
    "/",
    "/features",
    "/features/pipeline",
    "/demo",
    "/privacy",
    "/landing",
    "/sign-in",
    "/sign-in?returnTo=%2Fdashboard",
    "/sign-in-2",
    "/sign-in-3",
    "/sign-up",
    "/sign-up-2",
    "/forgot-password",
    "/forgot-password-3",
    "/reset-password",
    "/accept-invite?token=abc",
    "/verify-company",
    "/account-security",
    "/onboarding",
    "/errors/forbidden",
    "/errors/not-found",
    "/apply/form_1",
    "/apply/r/token",
    "/merchant-upload/token",
    "/login",
    "/register",
  ]) {
    assert.equal(anonymousRequestDisposition(path), "public", path)
    assert.equal(requiresSignInRedirect(path), false, path)
    assert.equal(isPublicPagePath(path), true, path)
  }
})

test("real app routes still require sign-in when logged out", () => {
  for (const path of [
    "/dashboard",
    "/dashboard/extra",
    "/home",
    "/deals",
    "/deals?q=acme",
    "/pipeline",
    "/calendar",
    "/intake",
    "/intake/in_1",
    "/applications",
    "/assistant",
    "/assistant/credits",
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
    "/settings/billing",
    "/users",
    "/faqs",
    "/tasks",
    "/chat",
    "/pricing",
    "/review/token",
    "/platform",
    "/platform/companies/ws_1",
    "/admin/status",
  ]) {
    assert.equal(anonymousRequestDisposition(path), "sign-in", path)
    assert.equal(requiresSignInRedirect(path), true, path)
    assert.equal(isProtectedAppPath(path), true, path)
    assert.equal(isPublicPagePath(path), false, path)
  }
})

test("unknown paths 404 instead of redirecting to sign-in", () => {
  for (const path of ["/not-a-real-page", "/funded-book", "/random/nested", "/dealsbook", "/feature", "/applyform"]) {
    assert.equal(anonymousRequestDisposition(path), "not-found", path)
    assert.equal(requiresSignInRedirect(path), false, path)
    assert.equal(isProtectedAppPath(path), false, path)
    assert.equal(isPublicPagePath(path), false, path)
  }
})

test("API routes are not HTML-redirected to sign-in", () => {
  for (const path of ["/api/auth/session", "/api/mca/deals", "/api/marketing/demo", "/api/webhooks/stripe"]) {
    assert.equal(anonymousRequestDisposition(path), "api", path)
    assert.equal(requiresSignInRedirect(path), false, path)
  }
})

test("public and protected prefix lists do not overlap", () => {
  const protectedSet = new Set<string>(PROTECTED_APP_PREFIXES)
  for (const prefix of PUBLIC_PAGE_PREFIXES) {
    assert.equal(protectedSet.has(prefix), false, prefix)
    assert.equal(isProtectedAppPath(prefix), false, prefix)
  }
  assert.equal(isProtectedAppPath("/"), false)
  assert.equal(isPublicPagePath("/dashboard"), false)
})
