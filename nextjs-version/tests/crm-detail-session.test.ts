import test from "node:test"
import assert from "node:assert/strict"
import { createDealDetailSession } from "../src/components/mca/deals/detail-session"

type Detail = { id: string; version: number }
function deferred() {
  let resolve!: (detail: Detail) => void, reject!: (error: Error) => void
  const promise = new Promise<Detail>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test("opening B ignores a late success from A and clears deal-specific drafts", async () => {
  const a = deferred(), b = deferred()
  const session = createDealDetailSession((id) => id === "a" ? a.promise : b.promise)
  const first = session.open("a")
  session.setNote("Only for A"); session.setTransition("closed")
  const second = session.open("b")
  assert.equal(session.getSnapshot().loading, true)
  assert.equal(session.getSnapshot().selected, null)
  assert.equal(session.getSnapshot().note, "")
  assert.equal(session.getSnapshot().transition, "")
  b.resolve({ id: "b", version: 1 }); await second
  a.resolve({ id: "a", version: 1 }); await first
  assert.equal(session.getSnapshot().selected?.id, "b")
})

test("a stale failure cannot hide the newer deal", async () => {
  const a = deferred(), b = deferred()
  const session = createDealDetailSession((id) => id === "a" ? a.promise : b.promise)
  const first = session.open("a"), second = session.open("b")
  b.resolve({ id: "b", version: 1 }); await second
  a.reject(new Error("A unavailable")); await first
  assert.equal(session.getSnapshot().selected?.id, "b")
  assert.equal(session.getSnapshot().failure, "")
  assert.equal(session.getSnapshot().loading, false)
})

test("closing invalidates pending work even when reopening the same deal", async () => {
  const old = deferred(), fresh = deferred(); let calls = 0
  const session = createDealDetailSession(() => calls++ === 0 ? old.promise : fresh.promise)
  const first = session.open("a"), oldMutation = session.capture()
  session.close(); const second = session.open("a")
  old.resolve({ id: "a", version: 9 }); await first
  assert.equal(session.isCurrent(oldMutation), false)
  assert.equal(session.getSnapshot().selected, null)
  fresh.resolve({ id: "a", version: 10 }); await second
  assert.equal(session.getSnapshot().selected?.version, 10)
})

test("active failure stops loading and retry loads the same ID", async () => {
  let calls = 0
  const session = createDealDetailSession(async (id) => {
    if (!calls++) throw new Error("Temporary failure")
    return { id, version: 1 }
  })
  await session.open("a")
  assert.equal(session.getSnapshot().loading, false)
  assert.equal(session.getSnapshot().failure, "Temporary failure")
  assert.equal(session.getSnapshot().id, "a")
  await session.open(session.getSnapshot().id!)
  assert.equal(session.getSnapshot().failure, "")
  assert.equal(session.getSnapshot().selected?.id, "a")
})

test("late mutation cannot update a newer selection or regress its version", async () => {
  const session = createDealDetailSession(async (id) => ({ id, version: 1 }))
  await session.open("a"); const oldMutation = session.capture()
  await session.open("b")
  if (session.isCurrent(oldMutation)) session.update({ id: "a", version: 2 })
  assert.equal(session.getSnapshot().selected?.id, "b")
  session.update({ id: "a", version: 3 })
  assert.equal(session.getSnapshot().selected?.id, "b")
  session.update({ id: "b", version: 3 }); session.update({ id: "b", version: 2 })
  assert.equal(session.getSnapshot().selected?.version, 3)
})

test("snapshot identity is stable and subscribers observe load and success", async () => {
  const pending = deferred(), session = createDealDetailSession(() => pending.promise)
  assert.equal(session.getSnapshot(), session.getSnapshot())
  const observed: boolean[] = []
  const unsubscribe = session.subscribe(() => observed.push(session.getSnapshot().loading))
  const loading = session.open("a")
  pending.resolve({ id: "a", version: 1 }); await loading
  assert.deepEqual(observed, [true, false])
  unsubscribe(); session.close()
  assert.deepEqual(observed, [true, false])
})
