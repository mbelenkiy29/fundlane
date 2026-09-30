import test from "node:test"
import assert from "node:assert/strict"
import { reserveLoopbackPort } from "./helpers/loopback-port.mjs"

test("loopback allocation skips reserved SIP ports and releases every reservation", async () => {
  const ports = [5060, 5061, 49152]
  const closed = []
  const reservation = await reserveLoopbackPort(() => {
    const port = ports.shift()
    return {
      once() {},
      listen(requestedPort, host, ready) {
        assert.equal(requestedPort, 0)
        assert.equal(host, "127.0.0.1")
        ready()
      },
      address: () => ({ port }),
      close(done) { closed.push(port); done() },
    }
  })
  assert.equal(reservation.port, 49152)
  assert.deepEqual(closed, [])
  await reservation.release()
  assert.deepEqual(closed, [5060, 5061, 49152])
})

async function withConcurrentReservations(allocate, inspect) {
  // Await every allocation so late successes are also covered by cleanup.
  const results = await Promise.allSettled(Array.from({ length: 12 }, allocate))
  const reservations = results.filter(value => value.status === "fulfilled").map(value => value.value)
  try {
    const failure = results.find(value => value.status === "rejected")
    if (failure) throw failure.reason
    await inspect(reservations)
  } finally {
    await Promise.all(reservations.map(value => value.release()))
  }
}

test("concurrent loopback reservations have distinct OS allocated ports", async () => {
  await withConcurrentReservations(() => reserveLoopbackPort(), reservations => {
    assert.equal(new Set(reservations.map(value => value.port)).size, reservations.length)
    assert.ok(reservations.every(value => ![5060, 5061].includes(value.port)))
  })
})

test("partial concurrent allocation failure releases early and late successes", async () => {
  const released = []
  const failure = new Error("synthetic allocation failure")
  await assert.rejects(withConcurrentReservations(async (_, index) => {
    if (index === 1) throw failure
    // Include successes that complete after the rejection.
    await new Promise(resolve => setImmediate(resolve))
    return { release: async () => { released.push(index) } }
  }, () => assert.fail("inspection must not run after allocation failure")), error => error === failure)
  assert.deepEqual(released.sort((a, b) => a - b), [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
})
