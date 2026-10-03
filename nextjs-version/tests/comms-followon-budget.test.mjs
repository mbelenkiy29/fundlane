import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { runCommsFollowons } from "../src/lib/mca/comms/followon-budget.ts"

test("reply scanning leaves a bounded share for renewal discovery after notification dispatch", async () => {
  let now = 1_000
  const calls = []
  const result = await runCommsFollowons({
    clock: "2026-10-02T00:00:00.000Z", deadlineMs: 31_000, now: () => now,
    replies: async (clock, deadline) => { calls.push(["replies", clock, deadline]); now = deadline; return { created: 1 } },
    renewals: async (clock, deadline) => { calls.push(["renewals", clock, deadline]); return { enqueued: 1 } },
  })
  assert.deepEqual(calls, [["replies", "2026-10-02T00:00:00.000Z", 16_000], ["renewals", "2026-10-02T00:00:00.000Z", 31_000]])
  assert.deepEqual(result, { funderReplies: { created: 1 }, renewalAlerts: { enqueued: 1 } })
})

test("a single enabled producer gets the remaining budget", async () => {
  for (const phase of ["replies", "renewals"]) {
    let observed
    await runCommsFollowons({ clock: "clock", deadlineMs: 31_000, now: () => 1_000,
      [phase]: async (_, deadline) => { observed = deadline; return {} } })
    assert.equal(observed, 31_000)
  }
})

test("expired ticks start no new producer and preserve omitted result fields", async () => {
  const unexpected = async () => { assert.fail("expired work must not start") }
  assert.deepEqual(await runCommsFollowons({ clock: "clock", deadlineMs: 1_000, now: () => 1_000,
    replies: unexpected, renewals: unexpected }), {})
  assert.deepEqual(await runCommsFollowons({ clock: "clock", deadlineMs: 31_000, now: () => 1_000 }), {})
})

test("renewal discovery also checks the live deadline after a reply phase overruns", async () => {
  let now = 1_000
  const result = await runCommsFollowons({ clock: "clock", deadlineMs: 31_000, now: () => now,
    replies: async () => { now = 31_000; return { created: 0 } },
    renewals: async () => { assert.fail("expired renewal work must not start") } })
  assert.deepEqual(result, { funderReplies: { created: 0 } })
})

test("reply failures propagate unchanged and do not start renewal discovery", async () => {
  const failure = new Error("synthetic reply failure")
  let renewals = 0
  await assert.rejects(runCommsFollowons({ clock: "clock", deadlineMs: 31_000, now: () => 1_000,
    replies: async () => { throw failure },
    renewals: async () => { renewals++; return {} } }), error => error === failure)
  assert.equal(renewals, 0)
})

test("renewal failures propagate unchanged after a successful reply phase", async () => {
  const failure = new Error("synthetic renewal failure")
  let replies = 0
  await assert.rejects(runCommsFollowons({ clock: "clock", deadlineMs: 31_000, now: () => 1_000,
    replies: async () => { replies++; return {} },
    renewals: async () => { throw failure } }), error => error === failure)
  assert.equal(replies, 1)
})

// This fixture loads the real scheduler/helper, replacing only database and
// delivery boundaries. Native Node stripping avoids requiring app dependencies.
// VM modules are enabled in the child, without changing the repository runner.
async function schedulerBoundaryProbe() {
  const assert = (await import("node:assert/strict")).default
  const fs = await import("node:fs")
  const path = await import("node:path")
  const vm = await import("node:vm")
  const { stripTypeScriptTypes } = await import("node:module")
  const results = []
  for (const scenario of [
    { live: false, scheduled: false },
    { live: true, scheduled: false },
    { live: false, scheduled: true },
    { live: true, scheduled: true },
    { live: true, scheduled: true, failNotification: true },
    { live: true, scheduled: true, failReply: true },
  ]) {
    const calls = [], imports = []
    let now = 1_000
    class FixtureDate extends Date { static now() { return now } }
    const clock = "2026-10-02T00:00:00.000Z"
    const failure = new Error("synthetic scheduler boundary failure")
    const context = vm.createContext({ Date: FixtureDate, process: { env: {
      MCA_NOTIFICATION_RUNTIME: "enabled",
      MCA_FUNDER_REPLY_LIVE_INGEST_ENABLED: String(scenario.live),
      MCA_FUNDER_REPLY_SCHEDULED_INGEST_ENABLED: String(scenario.scheduled),
    } }, console })
    const root = path.resolve("src/lib/mca/comms"), cache = new Map()
    const counts = { followups: { attempted: 0, sent: 0, skipped: 0 },
      digests: { attempted: 0, sent: 0, skipped: 0 }, webhooks: { attempted: 0, delivered: 0, failed: 0 } }
    const stubs = {
      "server-only": {},
      "../db": { nowIso: () => clock, getDatabase: () => ({ prepare: () => ({ all: async () => [{ workspace_id: "synthetic-company" }] }) }) },
      "./jobs": { runCommsJobs: async () => { calls.push("existing-comms"); return counts } },
      "./webhooks": { WORKFLOW_WEBHOOK_MAX_ATTEMPTS: 5 }, "./digest": {},
      "../onboarding/config": { onboardingEmailEnabled: () => false },
      "../notifications/worker": { runScheduledNotifications: async (receivedClock, limit, { deadlineMs }) => {
        calls.push("notifications")
        assert.equal(receivedClock, clock); assert.equal(limit, 25); assert.equal(deadlineMs, 231_000)
        if (scenario.failNotification) throw failure
        now = 21_000
        return { sent: 1 }
      } },
      "../submissions/replies": { runScheduledReplyIngest: async (receivedClock, deadlineMs) => {
        calls.push("replies")
        assert.equal(receivedClock, clock); assert.equal(deadlineMs, 231_000)
        if (scenario.failReply) throw failure
        return { created: 1 }
      } },
    }
    async function load(specifier) {
      const key = specifier === "./followon-budget" ? path.join(root, "followon-budget.ts") : specifier
      if (cache.has(key)) return cache.get(key)
      let fixtureModule
      if (Object.hasOwn(stubs, specifier)) {
        const exports = stubs[specifier]
        fixtureModule = new vm.SyntheticModule(Object.keys(exports), function () {
          for (const key of Object.keys(exports)) this.setExport(key, exports[key])
        }, { context, identifier: specifier })
        cache.set(key, fixtureModule)
        await fixtureModule.link(() => { throw new Error("Unexpected fixture dependency") })
      } else {
        assert.ok(specifier === "scheduler" || specifier === "./followon-budget", specifier)
        const file = path.join(root, specifier === "scheduler" ? "scheduler.ts" : "followon-budget.ts")
        fixtureModule = new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(file, "utf8"), { mode: "strip" }), {
          context, identifier: file, importModuleDynamically: async id => {
            imports.push(id)
            const dependency = await load(id)
            if (dependency.status === "linked") await dependency.evaluate()
            return dependency
          },
        })
        cache.set(key, fixtureModule)
        await fixtureModule.link(id => load(id))
      }
      return fixtureModule
    }
    const scheduler = await load("scheduler")
    await scheduler.evaluate()
    const enabled = scenario.live && scenario.scheduled
    if (scenario.failNotification || scenario.failReply) {
      await assert.rejects(scheduler.namespace.runScheduledCommsJobs(clock), error => error === failure)
    } else {
      const result = await scheduler.namespace.runScheduledCommsJobs(clock)
      assert.equal(result.notifications.sent, 1)
      assert.equal(result.funderReplies?.created, enabled ? 1 : undefined)
    }
    assert.deepEqual(calls, enabled && !scenario.failNotification
      ? ["existing-comms", "notifications", "replies"] : ["existing-comms", "notifications"])
    assert.equal(imports.includes("../submissions/replies"), enabled && !scenario.failNotification)
    results.push({ ...scenario, calls, status: "PASS" })
  }
  console.log(JSON.stringify(results))
}

test("actual scheduler dispatches notifications before gated replies and preserves failures", () => {
  const script = `(${schedulerBoundaryProbe.toString()})().catch(error => { console.error(error); process.exitCode = 1 })`
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", script], {
    cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(JSON.parse(result.stdout).length, 6)
})
