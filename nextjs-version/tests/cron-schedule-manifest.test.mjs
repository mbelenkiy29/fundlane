import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"

test("schedule manifest covers every cron route without installing Vercel crons", async () => {
  const routeNames = (await readdir(new URL("../src/app/api/cron/", import.meta.url), { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => `/api/cron/${entry.name}`)
    .sort()
  const manifest = JSON.parse(await readFile(new URL("../docs/ops/cron-schedules.json", import.meta.url), "utf8"))
  assert.deepEqual(manifest.map(entry => entry.path).sort(), routeNames)
  for (const entry of manifest) {
    assert.match(entry.cron, /\S/)
    assert.ok(Array.isArray(entry.requiredFlags))
    assert.match(entry.ownerIssue, /#\d+/)
  }
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"))
  assert.equal(Object.hasOwn(vercel, "crons"), false)
})
