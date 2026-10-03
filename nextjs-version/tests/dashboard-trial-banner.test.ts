import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const TRIAL_END = "2026-10-15T03:30:00.000Z"
/** Server-renders the dashboard trial banner in a process whose own zone is `tz` (the server's zone). */
function renderBanners(tz: string, zones: (string | null)[], trialEndsAt: string | null = TRIAL_END): string[] {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const React=require('react');const {renderToString}=require('react-dom/server');
    const {TrialBanner}=require('./src/app/(dashboard)/dashboard-2/components/trial-banner.tsx');
    console.log(JSON.stringify(${JSON.stringify(zones)}.map(timeZone=>renderToString(React.createElement(TrialBanner,{trialEndsAt:${JSON.stringify(trialEndsAt)},timeZone})))));
  `], { encoding: "utf8", env: { ...process.env, TZ: tz } })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim()) as string[]
}

test("dashboard trial banner shows the workspace time zone, not hard-coded UTC", () => {
  const [newYork, losAngeles] = renderBanners("Asia/Tokyo", ["America/New_York", "America/Los_Angeles"])
  assert.match(newYork, new RegExp(`Your trial ends <time dateTime="${TRIAL_END}">Oct 14, 2026, 11:30 PM EDT</time>\\.`))
  assert.match(losAngeles, /<time[^>]*>Oct 14, 2026, 8:30 PM PDT<\/time>/)
  for (const html of [newYork, losAngeles]) {
    assert.doesNotMatch(html, /UTC/)
    assert.match(html, /href="\/settings\/billing"[^>]*>Manage or cancel billing<\/a>/)
  }
})

test("a bad or missing workspace zone falls back safely: labeled UTC on the server, identical across server zones", () => {
  const zones = ["Not/AZone", "", null]
  const tokyo = renderBanners("Asia/Tokyo", zones), chicago = renderBanners("America/Chicago", zones)
  // Hydration-safe: the server output does not depend on the server's own zone; the browser re-renders in its zone.
  assert.deepEqual(tokyo, chicago)
  for (const html of tokyo) assert.match(html, new RegExp(`<time dateTime="${TRIAL_END}">Oct 15, 2026, 3:30 AM UTC</time>`))
})

test("no banner without a valid trial end", () => {
  assert.deepEqual(renderBanners("UTC", ["America/New_York"], null), [""])
  assert.deepEqual(renderBanners("UTC", ["America/New_York"], "not a date"), [""])
})
