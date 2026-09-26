import test, { mock } from "node:test"
import assert from "node:assert/strict"
import { AppError } from "../src/lib/mca/errors"

let syncEnabled = true
let sends = 0
const rateKeys: string[] = []
mock.module(new URL("../src/lib/mca/auth.ts", import.meta.url).href, { namedExports: {
  assertTrustedMutation: () => {},
  requireMembershipAccess: async (_request: Request, roles: string[]) => {
    assert.deepEqual(roles, ["admin", "super_admin"])
    return { workspaceId: "workspace-one", userId: "admin-one" }
  },
  consumeRequestRateLimit: async (key: string, limit: number) => {
    assert.equal(limit, 30)
    rateKeys.push(key)
    if (rateKeys.length > 2) throw new AppError(429, "rate_limit_exceeded", "Too many attempts.")
  },
} })
mock.module(new URL("../src/lib/mca/billing.ts", import.meta.url).href, { namedExports: {
  billingSeatSyncEnabled: () => syncEnabled,
} })
mock.module(new URL("../src/lib/mca/memberships.ts", import.meta.url).href, { namedExports: {
  inviteMember: async () => { sends++; return { id: "invite-one" } },
  resendInvitation: async () => { sends++; return { id: "invite-one" } },
} })

test("creation and resend share the sync-enabled workspace administrator rate limit", async () => {
  const { POST: invite } = await import("../src/app/api/invitations/route")
  const { POST: resend } = await import("../src/app/api/invitations/[id]/resend/route")
  const request = (path: string, body?: object) => new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
  })
  const inviteRequest = () => request("/api/invitations", { email: "invitee@example.test", name: "Invitee", role: "rep" })
  const resendRequest = () => resend(request("/api/invitations/invite-one/resend"), { params: Promise.resolve({ id: "invite-one" }) })
  assert.equal((await invite(inviteRequest())).status, 201)
  assert.equal((await resendRequest()).status, 201)
  const blocked = await invite(inviteRequest())
  assert.equal(blocked.status, 429)
  assert.equal((await blocked.json()).error.code, "rate_limit_exceeded")
  assert.deepEqual(rateKeys, Array(3).fill("team-invitation:workspace-one:admin-one"))
  assert.equal(sends, 2)
  syncEnabled = false
  assert.equal((await invite(inviteRequest())).status, 201)
  assert.equal(sends, 3)
  assert.equal(rateKeys.length, 3)
})
