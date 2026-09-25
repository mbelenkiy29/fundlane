import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  DEALS_PAGE_TITLE,
  PUBLIC_PAGE_PREFIXES,
  PROTECTED_APP_PREFIXES,
  anonymousRequestDisposition,
  isPublicPagePath,
  isProtectedAppPath,
  requiresSignInRedirect,
  unauthenticatedPageGate,
} from "../src/lib/mca/app-paths"

test("Deals is the shared nav and page title", () => {
  assert.equal(DEALS_PAGE_TITLE, "Deals")
})

test("public marketing and auth pages stay public while logged out", () => {
  for (const path of [
    "/",
    "/features",
    "/help",
    "/help/set-up-your-company",
    "/features/pipeline",
    "/demo",
    "/privacy",
    "/landing",
    "/sign-in",
    "/sign-in?returnTo=%2Fdashboard",
    "/sign-up",
    "/forgot-password",
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
    "/settings/team",
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
  for (const path of ["/not-a-real-page", "/funded-book", "/random/nested", "/dealsbook", "/feature", "/applyform", "/sign-in-2", "/users", "/tasks", "/chat", "/faqs"]) {
    assert.equal(anonymousRequestDisposition(path), "not-found", path)
    assert.equal(requiresSignInRedirect(path), false, path)
    assert.equal(isProtectedAppPath(path), false, path)
    assert.equal(isPublicPagePath(path), false, path)
    assert.deepEqual(unauthenticatedPageGate(path), { action: "not-found", status: 404 })
  }
})

test("anonymous gate returns sign-in status and destination only for real app routes", () => {
  assert.deepEqual(unauthenticatedPageGate("/deals", "/deals?q=acme"), {
    action: "sign-in",
    status: 307,
    location: "/sign-in?returnTo=%2Fdeals%3Fq%3Dacme",
  })
  assert.deepEqual(unauthenticatedPageGate("/dashboard"), {
    action: "sign-in",
    status: 307,
    location: "/sign-in?returnTo=%2Fdashboard",
  })
  assert.deepEqual(unauthenticatedPageGate("/features"), { action: "allow", status: 200 })
  assert.deepEqual(unauthenticatedPageGate("/api/mca/deals"), { action: "allow", status: 200 })
  assert.deepEqual(unauthenticatedPageGate("/not-a-real-page", "/not-a-real-page"), { action: "not-found", status: 404 })
})

test("unknown first segments no longer match a dashboard catch-all, so the 404 page can render", () => {
  const root = resolve(import.meta.dirname, "..")
  assert.equal(existsSync(resolve(root, "src/app/(dashboard)/[section]/page.tsx")), false)
  const layout = readFileSync(resolve(root, "src/app/(dashboard)/layout.tsx"), "utf8")
  assert.match(layout, /unauthenticatedPageGate/)
  assert.match(layout, /notFound\(\)/)
  assert.doesNotMatch(layout, /requiresSignInRedirect\(pathname\)\) redirect/)
  const notFoundPage = readFileSync(resolve(root, "src/app/not-found.tsx"), "utf8")
  assert.match(notFoundPage, /Page not found/)
  assert.match(notFoundPage, /href="\/"/)
  assert.doesNotMatch(notFoundPage, /href="\/dashboard"/)
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
