import test from "node:test"
import assert from "node:assert/strict"
import {
  assignableRoles,
  canDeactivateMember,
  canEditMember,
  eligibleManagers,
  filterTeam,
  invitationState,
} from "../src/lib/mca/team-view"
import type { MembershipSummary } from "../src/lib/mca/types"
const member = (
  id: string,
  patch: Partial<MembershipSummary> = {}
): MembershipSummary => ({
  id,
  userId: id,
  workspaceId: "company",
  name: id,
  email: `${id}@example.test`,
  phone: null,
  applicationIdentifier: id,
  senderAssociation: null,
  role: "rep",
  managerMembershipId: null,
  status: "active",
  createdAt: "2026-09-09",
  updatedAt: "2026-09-09",
  pendingInvitationId: null,
  invitationExpiresAt: null,
  invitationDeliveryStatus: null,
  ...patch,
})
test("team search combines status, role and manager and sorts by name", () => {
  const rows = [
    member("z", { name: "Zoe", managerMembershipId: "boss" }),
    member("amy", { name: "Amy", managerMembershipId: "boss" }),
    member("pending", { status: "pending" }),
    member("inactive", { status: "deactivated" }),
  ]
  assert.deepEqual(
    filterTeam(rows, "active", "", "rep", "boss").map((m) => m.name),
    ["Amy", "Zoe"]
  )
  assert.deepEqual(
    filterTeam(rows, "active", " AMY@EXAMPLE ", "all", "all").map((m) => m.id),
    ["amy"]
  )
  assert.equal(filterTeam(rows, "active", "", "all", "none").length, 0)
  assert.equal(filterTeam(rows, "pending", "", "all", "all").length, 1)
  assert.equal(
    filterTeam(rows, "deactivated", "missing", "all", "all").length,
    0
  )
})
test("invitation delivery failures stay actionable even after expiry", () => {
  const pending = member("p", {
    status: "pending",
    invitationExpiresAt: "2026-01-01",
    invitationDeliveryStatus: "failed",
  })
  assert.equal(invitationState(pending), "Delivery failed")
  assert.equal(
    invitationState({ ...pending, invitationDeliveryStatus: "sent" }),
    "Expired"
  )
  assert.equal(
    invitationState({
      ...pending,
      invitationExpiresAt: "2099-01-01",
      invitationDeliveryStatus: "sent",
    }),
    "Invitation sent"
  )
})
test("read-only, Super Admin and self-deactivation protections match server policy", () => {
  const admin = member("admin", { role: "super_admin" })
  assert.equal(canEditMember(admin, true, "admin"), false)
  assert.equal(
    canEditMember(
      member("inactive", { status: "deactivated" }),
      true,
      "super_admin"
    ),
    false
  )
  assert.equal(canEditMember(member("employee"), false, "rep"), false)
  assert.equal(
    canDeactivateMember(admin, [admin], true, "super_admin", "someone"),
    false
  )
  assert.equal(
    canDeactivateMember(member("self"), [], true, "admin", "self"),
    false
  )
  assert.equal(
    canDeactivateMember(
      admin,
      [admin, member("other", { role: "super_admin" })],
      true,
      "super_admin",
      "someone"
    ),
    true
  )
  assert.equal(assignableRoles("admin").includes("super_admin"), false)
  assert.equal(assignableRoles("super_admin").includes("super_admin"), true)
})
test("manager choices exclude self, descendants, inactive members and reps", () => {
  const rows = [
    member("boss", { role: "admin" }),
    member("self", { role: "manager" }),
    member("child", { role: "manager", managerMembershipId: "self" }),
    member("grandchild", { role: "manager", managerMembershipId: "child" }),
    member("inactive", { role: "admin", status: "deactivated" }),
    member("rep"),
  ]
  assert.deepEqual(
    eligibleManagers(rows, "self").map((m) => m.id),
    ["boss"]
  )
})
