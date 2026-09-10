import type { MembershipSummary, Role } from "./types"
export type TeamView = "active" | "pending" | "deactivated"
export const roleDescriptions: Record<Role, string> = {
  rep: "Works on assigned deals and day-to-day tasks.",
  manager: "Oversees assigned employees and their work.",
  admin: "Manages the team, workspace, and company billing.",
  super_admin: "Full administrative access, including Super Admin assignments.",
}
export function assignableRoles(actor?: Role): Role[] {
  return actor === "super_admin"
    ? ["rep", "manager", "admin", "super_admin"]
    : ["rep", "manager", "admin"]
}
export function filterTeam(
  members: MembershipSummary[],
  view: TeamView,
  query: string,
  role: string,
  manager: string
) {
  const search = query.trim().toLowerCase()
  return members
    .filter(
      (m) =>
        m.status === view &&
        (!search || `${m.name} ${m.email}`.toLowerCase().includes(search)) &&
        (role === "all" || m.role === role) &&
        (manager === "all" ||
          (manager === "none"
            ? !m.managerMembershipId
            : m.managerMembershipId === manager))
    )
    .sort(
      (a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email)
    )
}
export function invitationState(member: MembershipSummary, now = Date.now()) {
  if (member.invitationDeliveryStatus === "failed") return "Delivery failed"
  if (
    member.invitationExpiresAt &&
    new Date(member.invitationExpiresAt).getTime() <= now
  )
    return "Expired"
  if (member.invitationDeliveryStatus === "pending") return "Delivery pending"
  if (member.invitationDeliveryStatus === "preview") return "Preview"
  return "Invitation sent"
}
export function canEditMember(
  member: MembershipSummary,
  canManage: boolean,
  actor?: Role
) {
  return (
    canManage &&
    member.status !== "deactivated" &&
    (member.role !== "super_admin" || actor === "super_admin")
  )
}
export function canDeactivateMember(
  member: MembershipSummary,
  members: MembershipSummary[],
  canManage: boolean,
  actor?: Role,
  self?: string
) {
  return (
    canEditMember(member, canManage, actor) &&
    member.status === "active" &&
    member.id !== self &&
    (member.role !== "super_admin" ||
      members.some(
        (m) =>
          m.id !== member.id &&
          m.role === "super_admin" &&
          m.status === "active"
      ))
  )
}
export function eligibleManagers(
  members: MembershipSummary[],
  memberId?: string
) {
  const excluded = new Set(memberId ? [memberId] : [])
  // Exclude descendants as well as self; the server revalidates the relationship.
  for (let changed = true; changed; ) {
    changed = false
    for (const member of members)
      if (
        member.managerMembershipId &&
        excluded.has(member.managerMembershipId) &&
        !excluded.has(member.id)
      ) {
        excluded.add(member.id)
        changed = true
      }
  }
  return members
    .filter(
      (m) => m.status === "active" && m.role !== "rep" && !excluded.has(m.id)
    )
    .sort((a, b) => a.name.localeCompare(b.name))
}
