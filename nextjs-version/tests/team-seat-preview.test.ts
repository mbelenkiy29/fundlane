import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { inviteSeatIncreaseTarget } from "../src/lib/mca/team-seat-preview"

test("invite quotes a possible paid increase including pending acceptances", () => {
  const paid = { subscriptionId: "sub_test", status: "active", seatLimit: 2 }
  const state = { seatSyncEnabled: true, seatsCountPendingInvites: true, activeSeats: 2, pendingInvitationSeats: 0, billing: paid }
  assert.equal(inviteSeatIncreaseTarget(state), 3)
  assert.equal(inviteSeatIncreaseTarget({ ...state, activeSeats: 1 }), null)
  assert.equal(inviteSeatIncreaseTarget({ ...state, activeSeats: 1, pendingInvitationSeats: 1 }), 3)
  assert.equal(inviteSeatIncreaseTarget({ ...state, activeSeats: 1, pendingInvitationSeats: 1, seatsCountPendingInvites: false }), 3)
  assert.equal(inviteSeatIncreaseTarget({ ...state, billing: { ...paid, status: "trialing" } }), null)
  assert.equal(inviteSeatIncreaseTarget({ ...state, seatSyncEnabled: false }), null)
})

test("team invitation requires the Stripe preview before its confirmation request", () => {
  const panel = readFileSync(new URL("../src/components/mca/team-panel.tsx", import.meta.url), "utf8")
  const flow = panel.slice(panel.indexOf("function InviteDialog("), panel.indexOf("function MemberSheet("))
  assert.match(flow, /quote\?\.key !== draftKey \|\| quote\.selectedSeats !== selectedSeats/)
  assert.match(flow, /"\/api\/billing\/seats\/preview"/)
  assert.match(flow, /"\/api\/invitations"/)
  assert.ok(flow.indexOf('"/api/billing/seats/preview"') < flow.indexOf('"/api/invitations"'))
  assert.match(flow, /Confirm and send invitation/)
})
