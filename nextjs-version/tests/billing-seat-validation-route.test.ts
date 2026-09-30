import test, { mock } from "node:test"
import assert from "node:assert/strict"
let mutations = 0, previews = 0
mock.module(new URL("../src/lib/mca/auth.ts", import.meta.url).href, { namedExports: {
  assertTrustedMutation: () => {},
  requireMembershipAccess: async (_request: Request, roles: string[]) => {
    assert.deepEqual(roles, ["admin", "super_admin"])
    return { workspaceId: "company", userId: "owner", membershipId: "membership" }
  },
  consumeRequestRateLimit: async () => {},
} })
mock.module(new URL("../src/lib/mca/billing.ts", import.meta.url).href, { namedExports: {
  billingSeatSyncEnabled: () => true,
  billingManualSeatPreviewEnabled: () => false,
  changeBillingSeats: async (workspaceId: string, seats: number, userId: string) => {
    assert.equal(workspaceId, "company"); assert.equal(userId, "owner"); mutations++
    return { seats }
  },
  previewBillingSeatIncrease: async (workspaceId: string, seats: number) => {
    assert.equal(workspaceId, "company"); previews++; return { selectedSeats: seats }
  },
} })
const change = async (request: Request) => (await import("../src/app/api/billing/seats/route")).POST(request)
const preview = async (request: Request) => (await import("../src/app/api/billing/seats/preview/route")).POST(request)
const request = (body: string) => new Request("https://fundlane.example/api/billing/seats", { method: "POST", body })
for (const [name, route] of [["change", change], ["preview", preview]] as const) {
  test(`${name} rejects invalid seat input as a client error before any provider operation`, async () => {
    for (const value of [{ selectedSeats: 0 }, { selectedSeats: 1.5 }, { selectedSeats: 100001 }, { selectedSeats: "3" }, { selectedSeats: 3, workspaceId: "other" }]) {
      const response = await route(request(JSON.stringify(value)))
      assert.equal(response.status, 400, JSON.stringify(value))
      const body = await response.json()
      assert.equal(body.error.code, "validation_failed")
      assert.ok(body.error.fieldErrors)
    }
    const malformed = await route(request("{"))
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.json()).error.code, "invalid_json")
    assert.equal(mutations, 0); assert.equal(previews, 0)
  })
}
test("valid seat mutation and preview remain scoped to the authenticated company", async () => {
  assert.equal((await change(request('{"selectedSeats":3}'))).status, 200)
  assert.equal((await preview(request('{"selectedSeats":3}'))).status, 200)
  assert.equal(mutations, 1); assert.equal(previews, 1)
})
