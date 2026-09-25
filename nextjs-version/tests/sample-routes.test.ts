import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { sampleRouteRedirects } from "../src/lib/mca/sample-route-redirects"
import { safeAuthReturnTo } from "../src/lib/mca/auth-navigation"

const root = resolve(import.meta.dirname, "..")

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
  assert.match(config, /sampleRouteRedirects/)
  assert.match(config, /\.\.\.sampleRouteRedirects/)
  for (const expected of sampleRouteRedirects) {
    assert.notEqual(expected.destination, expected.source, expected.source)
    assert.match(expected.destination, /^\/(sign-in|sign-up|forgot-password|settings\/team|dashboard|assistant)?$/)
  }
})

test("sidebar and auth return paths cannot land on removed sample routes", () => {
  const sidebar = readFileSync(resolve(root, "src/components/app-sidebar.tsx"), "utf8")
  for (const source of sampleRouteRedirects.map((redirect) => redirect.source)) {
    assert.equal(sidebar.includes(`url: "${source}"`), false, source)
    assert.equal(safeAuthReturnTo(source), "/dashboard", source)
    assert.equal(safeAuthReturnTo(`${source}/next`), "/dashboard", `${source}/next`)
  }
})

test("eslint excludes generated supabase runtime bundles and still lints application source", () => {
  const config = readFileSync(resolve(root, "eslint.config.mjs"), "utf8")
  assert.match(config, /supabase\/functions\/\*\*\/runtime\.js/)
  assert.doesNotMatch(config, /["']src\/\*\*["']/)
  assert.doesNotMatch(config, /["']scripts\/\*\*["']/)

  const probeDir = resolve(root, "supabase/functions/_lint_probe")
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(resolve(probeDir, "runtime.js"), "var unusedGeneratedBinding = 1\n")
  try {
    const ignored = spawnSync("pnpm", ["exec", "eslint", "supabase/functions/_lint_probe/runtime.js"], {
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
