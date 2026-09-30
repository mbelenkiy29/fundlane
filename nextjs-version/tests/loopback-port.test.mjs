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

test("concurrent loopback reservations have distinct OS allocated ports", async () => {
  const reservations = await Promise.all(Array.from({ length: 12 }, () => reserveLoopbackPort()))
  try {
    assert.equal(new Set(reservations.map(value => value.port)).size, reservations.length)
    assert.ok(reservations.every(value => ![5060, 5061].includes(value.port)))
  } finally {
    await Promise.all(reservations.map(value => value.release()))
  }
})
