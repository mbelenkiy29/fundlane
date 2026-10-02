import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import test from "node:test"
import sitemap from "../src/app/sitemap"
import { MARKETING_ORIGIN } from "../src/lib/marketing/metadata"
import { retiredPublicRedirects } from "../src/lib/mca/retired-public-redirects"

const root = resolve(import.meta.dirname, "..")

const pr240Files = new Set([
  "docs/acceptance/marketing-get-started-cta.md",
  "src/app/changelog/page.tsx",
  "src/app/features/page.tsx",
  "src/components/marketing/home.tsx",
  "src/components/marketing/marketing.css",
  "src/components/marketing/mobile-nav.tsx",
  "src/components/marketing/shell.tsx",
  "src/components/marketing/trial-checkout-start.tsx",
  "src/components/marketing/trial-start-button.tsx",
  "tests/browser/public-entry/README.md",
  "tests/browser/public-entry/entry.tsx",
  "tests/browser/public-entry/run.mjs",
  "tests/helpers/public-entry-render.ts",
  "tests/marketing-site.test.ts",
  "tests/onboarding-navigation.test.ts",
  "tests/public-pricing.test.ts",
])

const removedRoutes = [
  "src/app/demo/page.tsx",
  "src/app/api/marketing/demo/route.ts",
  "src/app/api/marketing/receiver/route.ts",
  "src/app/platform/demo-requests/page.tsx",
  "src/app/api/platform/demo-requests/route.ts",
  "src/components/marketing/demo-form.tsx",
  "src/components/marketing/demo-fallback.tsx",
  "src/lib/marketing/demo.ts",
  "src/lib/marketing/receiver.ts",
  "src/app/(auth)/sign-up/components/signup-form-1.tsx",
  "src/app/(auth)/sign-up/components/signup-legal-agreement.tsx",
] as const

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") return []
      return sourceFiles(fullPath)
    }
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [fullPath] : []
  })
}

test("/demo and /sign-up permanently redirect to /", () => {
  const config = readFileSync(join(root, "next.config.ts"), "utf8")
  assert.match(config, /retiredPublicRedirects/)
  assert.match(config, /\.\.\.retiredPublicRedirects/)
  for (const expected of retiredPublicRedirects) {
    assert.equal(expected.destination, "/")
    assert.equal(expected.permanent, true)
  }
  assert.deepEqual(
    retiredPublicRedirects.map((redirect) => redirect.source),
    ["/demo", "/demo/:path*", "/sign-up", "/sign-up/:path*", "/register", "/auth/sign-up"],
  )
})

test("retired demo API and form files are gone", () => {
  for (const file of removedRoutes) {
    assert.equal(existsSync(join(root, file)), false, file)
  }
})

test("sitemap has no /demo entry", () => {
  const urls = sitemap().map((entry) => entry.url)
  assert.ok(!urls.includes(`${MARKETING_ORIGIN}/demo`))
  assert.ok(!urls.some((url) => url.includes("/demo")))
})

test("Book a demo is absent from app source outside PR #240 files", () => {
  const hits: string[] = []
  for (const file of sourceFiles(join(root, "src"))) {
    const rel = relative(root, file).replaceAll("\\", "/")
    if (pr240Files.has(rel)) continue
    if (/book a demo/i.test(readFileSync(file, "utf8"))) hits.push(rel)
  }
  assert.deepEqual(hits, [])
})

test("public sign-up page file is a home redirect, not a company form", () => {
  const page = readFileSync(join(root, "src/app/(auth)/sign-up/page.tsx"), "utf8")
  assert.match(page, /redirect\("\/"\)/)
  assert.doesNotMatch(page, /Create your company workspace|Book a demo|SignupForm1/)
  assert.equal(statSync(join(root, "src/app/(auth)/sign-up/page.tsx")).isFile(), true)
})
