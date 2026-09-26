import test, { mock } from "node:test"
import assert from "node:assert/strict"
import { AppError } from "../src/lib/mca/errors"

const rateKeys: string[] = []
let previewCalls = 0
mock.module(new URL("../src/lib/mca/auth.ts", import.meta.url).href, { namedExports: {
  assertTrustedMutation: () => {},
  requireMembershipAccess: async (_request: Request, roles: string[]) => {
    assert.deepEqual(roles, ["admin", "super_admin"])
    return { workspaceId: "workspace-one", membershipId: "member-one" }
  },
  consumeRequestRateLimit: async (key: string, limit: number) => {
    assert.equal(limit, 30)
    rateKeys.push(key)
    if (rateKeys.length > 2) throw new AppError(429, "rate_limit_exceeded", "Too many attempts.")
  },
} })
mock.module(new URL("../src/lib/mca/billing.ts", import.meta.url).href, { namedExports: {
  billingSeatSyncEnabled: () => true,
  previewBillingSeatIncrease: async (workspaceId: string, selectedSeats: number) => {
    assert.equal(workspaceId, "workspace-one")
    assert.equal(selectedSeats, 6)
    previewCalls++
    return { selectedSeats, amountDue: 1234, currency: "usd" }
  },
} })

test("seat preview limits each billing administrator before calling Stripe", async () => {
  const { POST } = await import("../src/app/api/billing/seats/preview/route")
  const request = () => new Request("http://localhost/api/billing/seats/preview", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selectedSeats: 6 }),
  })
  assert.equal((await POST(request())).status, 200)
  assert.equal((await POST(request())).status, 200)
  const blocked = await POST(request())
  assert.equal(blocked.status, 429)
  assert.equal((await blocked.json()).error.code, "rate_limit_exceeded")
  assert.deepEqual(rateKeys, Array(3).fill("billing-seat-preview:workspace-one:member-one"))
  assert.equal(previewCalls, 2)
})
