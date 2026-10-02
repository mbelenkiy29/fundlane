import test from "node:test"
import assert from "node:assert/strict"
import { startPlatformRefresh, billingObservationStatus, type BillingObservation } from "../src/lib/mca/platform-refresh"

test("visible refresh runs every 30 seconds, refreshes on return and cleans up", t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const document = new EventTarget() as EventTarget & { visibilityState: string }
  document.visibilityState = "visible"
  const original = Object.getOwnPropertyDescriptor(globalThis, "document")
  Object.defineProperty(globalThis, "document", { value: document, configurable: true })
  try {
    let reads = 0
    const stop = startPlatformRefresh(() => reads++)
    t.mock.timers.tick(29_999); assert.equal(reads, 0)
    t.mock.timers.tick(1); assert.equal(reads, 1)
    document.visibilityState = "hidden"
    document.dispatchEvent(new Event("visibilitychange")); t.mock.timers.tick(60_000)
    assert.equal(reads, 1)
    document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange"))
    assert.equal(reads, 2)
    stop(); t.mock.timers.tick(60_000); document.dispatchEvent(new Event("visibilitychange"))
    assert.equal(reads, 2)
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original)
    else Reflect.deleteProperty(globalThis, "document")
  }
})

test("Stripe freshness requires an actual provider read and exposes failures and pending work", () => {
  const now = Date.parse("2026-10-01T12:00:00Z")
  const row: BillingObservation = { workspaceId: "synthetic", companyName: "Synthetic", livemode: true, source: "stripe_api", syncedAt: new Date(now - 15 * 60_000).toISOString(), pending: false, failed: false }
  assert.equal(billingObservationStatus(row, now), "verified")
  assert.equal(billingObservationStatus(row, now + 1), "stale")
  assert.equal(billingObservationStatus({ ...row, source: "free" }, now), "unverified")
  assert.equal(billingObservationStatus({ ...row, syncedAt: new Date(now + 1).toISOString() }, now), "unverified")
  assert.equal(billingObservationStatus({ ...row, pending: true }, now), "pending")
  assert.equal(billingObservationStatus({ ...row, pending: true, failed: true }, now), "failed")
  assert.equal(billingObservationStatus({ ...row, livemode: null }, now), "not_connected")
})
