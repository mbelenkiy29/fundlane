import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { inviteSeatIncreaseTarget, inviteSeatDescription } from "../src/lib/mca/team-seat-preview"

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

test("invite description distinguishes reusable, purchased, and selected renewal capacity",()=>{
  const billing={activeSeats:1,pendingInvitationSeats:0,seatsCountPendingInvites:false,billing:{seatLimit:2,status:"active"},state:{pending_seats:null}}
  assert.equal(inviteSeatDescription(billing),"Send an invitation to join your company. They'll use one of your unused seats (1 of 2 in use).")
  assert.equal(inviteSeatDescription({...billing,activeSeats:2}),"All 2 seats are in use. A seat is added when they accept.")
  assert.equal(inviteSeatDescription({...billing,activeSeats:2,seatsCountPendingInvites:true}),"All 2 seats are in use. A seat is added when this invitation is sent.")
  assert.match(inviteSeatDescription({...billing,state:{pending_seats:1}}),/Change or cancel it in Plans & Billing/)
  assert.equal(inviteSeatDescription({...billing,billing:{...billing.billing,status:"trialing"}}),"Send an invitation to join your company. One seat is reserved until they join.")
})
