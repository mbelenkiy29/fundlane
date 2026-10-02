import test from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  PUBLIC_PAGE_PREFIXES,
  PROTECTED_APP_PREFIXES,
  anonymousRequestDisposition,
} from "../src/lib/mca/app-paths"
import { sampleRouteRedirects } from "../src/lib/mca/sample-route-redirects"
import { safeAuthReturnTo } from "../src/lib/mca/auth-navigation"

const root = resolve(import.meta.dirname, "..")

const expectedRedirects = [
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

const removedPages = [
  "src/app/(auth)/sign-in-2/page.tsx",
  "src/app/(auth)/sign-in-3/page.tsx",
  "src/app/(auth)/sign-up-2/page.tsx",
  "src/app/(auth)/sign-up-3/page.tsx",
  "src/app/(auth)/forgot-password-2/page.tsx",
  "src/app/(auth)/forgot-password-3/page.tsx",
  "src/app/(dashboard)/users/page.tsx",
  "src/app/(dashboard)/tasks/page.tsx",
  "src/app/(dashboard)/chat/page.tsx",
  "src/app/(dashboard)/faqs/page.tsx",
] as const

const productPages = [
  "src/app/(auth)/sign-in/page.tsx",
  "src/app/(auth)/sign-up/page.tsx",
  "src/app/(auth)/forgot-password/page.tsx",
  "src/app/(dashboard)/settings/team/page.tsx",
  "src/app/(dashboard)/mail/page.tsx",
  "src/app/(dashboard)/dashboard/page.tsx",
  "src/app/(dashboard)/assistant/page.tsx",
] as const

test("template sample pages are removed and product routes remain", () => {
  for (const file of removedPages) assert.equal(existsSync(resolve(root, file)), false, file)
  for (const file of productPages) assert.equal(existsSync(resolve(root, file)), true, file)
})

test("old sample URLs redirect to live product routes", () => {
  const config = readFileSync(resolve(root, "next.config.ts"), "utf8")
  assert.match(config, /from "\.\/src\/lib\/mca\/sample-route-redirects"/)
  assert.match(config, /\.\.\.sampleRouteRedirects/)
  assert.deepEqual(sampleRouteRedirects, expectedRedirects)
  assert.equal(sampleRouteRedirects.length, expectedRedirects.length)
  for (const expected of expectedRedirects) {
    const match = sampleRouteRedirects.find((redirect) => redirect.source === expected.source)
    assert.deepEqual(match, expected, expected.source)
    assert.equal(expected.permanent, true, expected.source)
  }
})

test("sidebar and auth return paths cannot land on removed sample routes", () => {
  const sidebar = readFileSync(resolve(root, "src/components/app-sidebar.tsx"), "utf8")
  const prefixes = new Set<string>([...PUBLIC_PAGE_PREFIXES, ...PROTECTED_APP_PREFIXES])
  for (const source of expectedRedirects.map((redirect) => redirect.source)) {
    assert.equal(sidebar.includes(`url: "${source}"`), false, source)
    assert.equal(prefixes.has(source), false, source)
    assert.equal(safeAuthReturnTo(source), "/dashboard", source)
    assert.equal(safeAuthReturnTo(`${source}/next`), "/dashboard", `${source}/next`)
  }
  for (const path of ["/sign-in-2", "/sign-up-3", "/forgot-password-2", "/users", "/tasks", "/chat", "/faqs"]) {
    assert.equal(anonymousRequestDisposition(path), "not-found", path)
  }
})

test("eslint excludes generated supabase runtime bundles and still lints application source", () => {
  const config = readFileSync(resolve(root, "eslint.config.mjs"), "utf8")
  assert.match(config, /supabase\/functions\/\*\*\/runtime\.js/)
  assert.doesNotMatch(config, /["']src\/\*\*["']/)
  assert.doesNotMatch(config, /["']scripts\/\*\*["']/)

  const probeRel = `supabase/functions/_lint_probe_${randomBytes(6).toString("hex")}`
  const probeDir = resolve(root, probeRel)
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(resolve(probeDir, "runtime.js"), "var unusedGeneratedBinding = 1\n")
  try {
    const ignored = spawnSync("pnpm", ["exec", "eslint", `${probeRel}/runtime.js`], {
      cwd: root,
      encoding: "utf8",
    })
    assert.equal(ignored.status, 0, ignored.stdout + ignored.stderr)
    const covered = spawnSync("pnpm", ["exec", "eslint", "src/lib/mca/sample-route-redirects.ts", "src/lib/mca/auth-navigation.ts"], {
      cwd: root,
      encoding: "utf8",
    })
    assert.equal(covered.status, 0, covered.stdout + covered.stderr)
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
})
