import assert from "node:assert/strict"
import { before, mock, test } from "node:test"

const workspaceId = "11111111-1111-4111-8111-111111111111"
const token = "synthetic-invitation-token-1234567890"
let accepted = false
mock.module(new URL("../src/lib/mca/auth.ts", import.meta.url).href, { namedExports: {
  assertTrustedMutation: () => {}, clientRateKey: () => "test", consumeRequestRateLimit: async () => {},
} })
mock.module(new URL("../src/lib/mca/supabase-auth.ts", import.meta.url).href, { namedExports: {
  supabaseIdentity: async () => ({ user: { id: "synthetic-invitee" }, email: "invitee@example.test", sessionId: "synthetic-session" }),
  setActiveWorkspace: async (_identity: unknown, selected: string) => { assert.equal(selected, workspaceId) },
} })
mock.module(new URL("../src/lib/mca/supabase-team.ts", import.meta.url).href, { namedExports: {
  acceptSupabaseInvitation: async (_identity: unknown, received: string) => { assert.equal(received, token); accepted = true; return workspaceId },
  inspectSupabaseInvitation: async () => ({}),
} })
let accept: typeof import("../src/app/api/invitations/accept/route").POST
before(async () => { ({ POST: accept } = await import("../src/app/api/invitations/accept/route")) })

test("valid invitation acceptance remains available in invite-only mode", async () => {
  process.env.MCA_SIGNUP_MODE = "invite_only"
  try {
    const response = await accept(new Request("http://localhost/api/invitations/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).workspaceId, workspaceId)
    assert.equal(accepted, true)
  } finally { delete process.env.MCA_SIGNUP_MODE }
})
