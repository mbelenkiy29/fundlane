import test from "node:test"
import assert from "node:assert/strict"
import { waitForAcceptanceReconciliation } from "../scripts/stripe/webhook-acceptance-runtime"

const result = { queued: true, workspaceId: "company", jobId: "job" }
const receipt = { event_id: "event", workspace_id: "company", stripe_customer_id: "customer" }
test("acceptance requires durable receipt and exact job completion after the queued response", async () => {
  let polls = 0
  await waitForAcceptanceReconciliation(async (sql, parameters) => {
    if (sql.includes("stripe_billing_events")) return { rows: [receipt] }
    assert.deepEqual(parameters, ["job", "company", "event"])
    assert.match(sql, /kind='billing_reconcile'/)
    return { rows: [{ state: ++polls === 1 ? "queued" : "complete" }] }
  }, result, "event", "company", "customer")
  assert.equal(polls, 2)
})
test("queued or missing jobs cannot falsely certify completion", async () => {
  for (const rows of [[{ state: "queued" }], [], [{ state: "failed" }]]) {
    await assert.rejects(waitForAcceptanceReconciliation(async sql => ({ rows: sql.includes("stripe_billing_events") ? [receipt] : rows }), result, "event", "company", "customer", 0), /did not complete/)
  }
})
test("receipt/customer/workspace mismatch and nonqueued acknowledgements cannot certify acceptance", async () => {
  for (const acknowledgement of [{ reconciled: true }, { ...result, workspaceId: "other" }]) {
    await assert.rejects(waitForAcceptanceReconciliation(async () => ({ rows: [receipt] }), acknowledgement, "event", "company", "customer"))
  }
  await assert.rejects(waitForAcceptanceReconciliation(async () => ({ rows: [{ ...receipt, stripe_customer_id: "other" }] }), result, "event", "company", "customer"))
})
