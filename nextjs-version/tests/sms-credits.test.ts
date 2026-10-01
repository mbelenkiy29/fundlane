import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase, newId, nowIso, withTransaction } from "../src/lib/mca/db"
import * as credits from "../src/lib/mca/sms/credits"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
before(async () => {
  fixture = await createPostgresTestDatabase("sms_credits")
  Object.assign(process.env, fixture.env())
})
after(async () => { await closeDatabaseForTests(); await fixture?.close() })
async function company() {
  const workspaceId = newId()
  await getDatabase().execute("INSERT INTO workspaces(id,name,feature_flags,page_visibility,created_at,updated_at) VALUES (?,?,'{}','{}',?,?)", [workspaceId, workspaceId, nowIso(), nowIso()])
  return workspaceId
}
async function message(workspaceId: string) {
  const messageId = newId()
  await getDatabase().execute(`INSERT INTO mca_sms_messages(id,workspace_id,deal_id,account_id,provider,sender_identity_cipher,recipient_hash,recipient_cipher,body_cipher,content_hash,payload_hash,state,idempotency_key,correlation_id,created_at,updated_at)
    VALUES (?,?,'synthetic','synthetic','twilio','cipher','hash','cipher','cipher','content','payload','pending',?,?,?,?)`, [messageId, workspaceId, messageId, messageId, nowIso(), nowIso()])
  return messageId
}
const amounts = async (workspaceId: string) => { const { updatedAt: _updatedAt, ...balance } = await credits.getSmsCreditBalance(workspaceId); assert.ok(_updatedAt); return balance }
const grant = (workspaceId: string, segments = 100, purchaseId = newId(), providerPaymentId = newId()) =>
  withTransaction(db => credits.grantSmsCredits(db, { workspaceId, segments, purchaseId, providerPaymentId }))
const reserve = (workspaceId: string, messageId: string, segments: number, payloadHash = "payload") =>
  withTransaction(db => credits.reserveSmsCredits(db, { workspaceId, messageId, segments, payloadHash }))
const settle = (workspaceId: string, messageId: string, eventKey: string, chargeSegments = 2) =>
  withTransaction(db => credits.settleSmsCredits(db, { workspaceId, messageId, eventKey, chargeSegments }))
const release = (workspaceId: string, messageId: string, eventKey: string) =>
  withTransaction(db => credits.releaseSmsCredits(db, { workspaceId, messageId, eventKey }))

test("duplicate_payment_grants_once", async () => {
  const workspaceId = await company(), purchaseId = newId(), payment = newId()
  await Promise.all([grant(workspaceId, 100, purchaseId, payment), grant(workspaceId, 100, purchaseId, payment)])
  const balance = await credits.getSmsCreditBalance(workspaceId)
  assert.equal(balance.balanceSegments, 100)
  assert.equal(balance.availableSegments, 100)
  await assert.rejects(grant(workspaceId, 101, purchaseId, payment), { code: "sms_credit_identity_conflict" })
  await assert.rejects(grant(workspaceId, 100, newId(), payment), { code: "sms_credit_identity_conflict" })
  await assert.rejects(grant(await company(), 100, purchaseId, payment), { code: "sms_credit_identity_conflict" })
})
test("concurrent_reservations_do_not_overspend", async () => {
  const workspaceId = await company()
  await grant(workspaceId)
  const ids = await Promise.all([message(workspaceId), message(workspaceId)])
  const results = await Promise.allSettled(ids.map(id => reserve(workspaceId, id, 60)))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.deepEqual(await amounts(workspaceId), { balanceSegments: 100, reservedSegments: 60, availableSegments: 40 })
})
test("settlement_is_idempotent", async () => {
  const workspaceId = await company(), messageId = await message(workspaceId), eventKey = newId()
  await grant(workspaceId)
  await reserve(workspaceId, messageId, 2)
  await Promise.all([settle(workspaceId, messageId, eventKey), settle(workspaceId, messageId, eventKey)])
  await settle(workspaceId, messageId, newId())
  await assert.rejects(release(workspaceId, messageId, newId()), { code: "sms_credit_state_conflict" })
  const balance = await credits.getSmsCreditBalance(workspaceId)
  assert.equal(balance.balanceSegments, 98)
  assert.equal(balance.reservedSegments, 0)
})
test("reservation identity and tenant ownership cannot change", async () => {
  const workspaceId = await company(), foreign = await company(), messageId = await message(workspaceId)
  await grant(workspaceId); await grant(foreign)
  const original = await reserve(workspaceId, messageId, 3)
  assert.deepEqual(await reserve(workspaceId, messageId, 3), original)
  await assert.rejects(getDatabase().execute("UPDATE sms_credit_reservations SET payload_hash='changed' WHERE id=?", [original.reservationId]), /immutable/)
  await assert.rejects(getDatabase().execute("UPDATE sms_credit_reservations SET segments=4 WHERE id=?", [original.reservationId]), /immutable/)
  await assert.rejects(reserve(workspaceId, messageId, 3, "changed"), { code: "sms_credit_identity_conflict" })
  await assert.rejects(reserve(workspaceId, messageId, 4), { code: "sms_credit_identity_conflict" })
  await assert.rejects(reserve(foreign, messageId, 3), { code: "sms_credit_message_not_found" })
  await assert.rejects(settle(foreign, messageId, newId()), { code: "sms_credit_reservation_not_found" })
  await assert.rejects(getDatabase().execute("INSERT INTO sms_credit_reservations(id,workspace_id,message_id,segments,payload_hash,state,created_at) VALUES (?,?,?,1,'payload','reserved',?)", [newId(), foreign, await message(workspaceId), nowIso()]), { code: "23503" })
})
test("release restores availability and immutable events reject conflicting replays", async () => {
  const workspaceId = await company(), messageId = await message(workspaceId), second = await message(workspaceId), eventKey = newId()
  await grant(workspaceId); await reserve(workspaceId, messageId, 10); await reserve(workspaceId, second, 2)
  await release(workspaceId, messageId, eventKey); await release(workspaceId, messageId, eventKey)
  await release(workspaceId, messageId, newId())
  await assert.rejects(settle(workspaceId, messageId, newId()), { code: "sms_credit_state_conflict" })
  await assert.rejects(settle(workspaceId, second, eventKey), { code: "sms_credit_identity_conflict" })
  await settle(workspaceId, second, newId(), 1)
  await assert.rejects(settle(workspaceId, second, newId(), 2), { code: "sms_credit_identity_conflict" })
  assert.deepEqual(await amounts(workspaceId), { balanceSegments: 99, reservedSegments: 0, availableSegments: 99 })
  const rows = await getDatabase().query<{kind: string; balance_delta: number; reserved_delta: number}>("SELECT kind,balance_delta,reserved_delta FROM sms_credit_ledger WHERE workspace_id=? ORDER BY created_at,id", [workspaceId])
  assert.equal(rows.rows.filter(r => r.kind === "release" && r.reserved_delta !== 0).length, 1)
  assert.equal(rows.rows.filter(r => r.kind === "settle" && r.balance_delta !== 0).length, 1)
})
test("integer bounds and settlement ceiling preserve balances", async () => {
  const workspaceId = await company(), messageId = await message(workspaceId)
  for (const n of [0, -1, 1.5, NaN, Infinity, 2147483648, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(grant(workspaceId, n), { code: "sms_credit_quantity_invalid" })
    await assert.rejects(reserve(workspaceId, messageId, n), { code: "sms_credit_quantity_invalid" })
  }
  await grant(workspaceId, 2147483647)
  await assert.rejects(grant(workspaceId, 1), { code: "sms_credit_overflow" })
  await reserve(workspaceId, messageId, 2)
  await assert.rejects(settle(workspaceId, messageId, newId(), 3), { code: "sms_credit_quantity_invalid" })
  await assert.rejects(settle(workspaceId, messageId, newId(), -1), { code: "sms_credit_quantity_invalid" })
  await settle(workspaceId, messageId, newId(), 0)
  assert.deepEqual(await amounts(workspaceId), { balanceSegments: 2147483647, reservedSegments: 0, availableSegments: 2147483647 })
})
test("pool executor cannot partially commit; active transactions compose and roll back", async () => {
  const workspaceId = await company(), input = { workspaceId, purchaseId: newId(), providerPaymentId: newId(), segments: 100 }
  await assert.rejects(credits.grantSmsCredits(getDatabase(), input), { code: "transaction_required" })
  await assert.rejects(withTransaction(async db => {
    await credits.grantSmsCredits(db, input)
    await withTransaction(inner => credits.reserveSmsCredits(inner, { workspaceId, messageId: "missing", segments: 1, payloadHash: "payload" }))
  }), { code: "sms_credit_message_not_found" })
  assert.equal((await credits.getSmsCreditBalance(workspaceId)).balanceSegments, 0)
  const pool = getDatabase()
  await withTransaction(async db => {
    await assert.rejects(credits.grantSmsCredits(pool, input), { code: "transaction_required" })
    await withTransaction(inner => credits.grantSmsCredits(inner, input))
    assert.equal((await credits.getSmsCreditBalance(workspaceId, db)).balanceSegments, 100)
  })
})

test("retained asynchronous transaction context cannot write after commit", async () => {
  const workspaceId = await company()
  let resume!: () => void
  let late!: Promise<unknown>
  const gate = new Promise<void>(resolve => { resume = resolve })
  await withTransaction(async db => {
    late = gate.then(() => credits.grantSmsCredits(db, { workspaceId, purchaseId: newId(), providerPaymentId: newId(), segments: 100 }))
  })
  const rejected = assert.rejects(late, { code: "transaction_required" })
  resume()
  await rejected
  assert.equal((await credits.getSmsCreditBalance(workspaceId)).balanceSegments, 0)
})

test("competing terminal operations apply only one outcome and ledger deltas reconcile", async () => {
  const workspaceId = await company(), messageId = await message(workspaceId)
  await grant(workspaceId); await reserve(workspaceId, messageId, 2)
  const results = await Promise.allSettled([settle(workspaceId, messageId, newId()), release(workspaceId, messageId, newId())])
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1)
  const mismatches = await getDatabase().query(`SELECT a.workspace_id FROM sms_credit_accounts a
    LEFT JOIN sms_credit_ledger l ON l.workspace_id=a.workspace_id GROUP BY a.workspace_id
    HAVING a.balance_segments <> COALESCE(sum(l.balance_delta),0) OR a.reserved_segments <> COALESCE(sum(l.reserved_delta),0)`)
  assert.equal(mismatches.rows.length, 0)
  const reservations = await getDatabase().query(`SELECT a.workspace_id FROM sms_credit_accounts a
    LEFT JOIN sms_credit_reservations r ON r.workspace_id=a.workspace_id AND r.state='reserved' GROUP BY a.workspace_id
    HAVING a.reserved_segments <> COALESCE(sum(r.segments),0)`)
  assert.equal(reservations.rows.length, 0)
})
