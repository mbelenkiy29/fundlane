import type { DealActor, DealAssignment, DealRecord } from "./schema"

export function canActorAccessDeal(actor: DealActor, record: Pick<DealRecord, "workspaceId" | "assignments"> & { id?: string }): boolean {
  if (actor.workspaceId !== record.workspaceId) return false
  if (actor.source === "system" && actor.intakeDealId) return actor.intakeDealId === record.id
  if (actor.source === "api_key" || actor.role === "admin" || actor.role === "super_admin") return true
  if (!actor.membershipId) return false
  if (record.assignments.some((item) => item.membershipId === actor.membershipId)) return true
  return actor.role === "manager" && record.assignments.some(
    (item) => item.kind === "originator" && actor.managedMembershipIds.includes(item.membershipId),
  )
}

export function permittedAssignmentIds(actor: DealActor): Set<string> {
  if (actor.source === "api_key" || actor.role === "admin" || actor.role === "super_admin") return new Set(actor.activeMembershipIds)
  if (actor.role === "manager") return new Set([actor.membershipId, ...actor.managedMembershipIds].filter(Boolean) as string[])
  return new Set(actor.membershipId ? [actor.membershipId] : [])
}

export function normalizePrimaryAssignments(assignments: DealAssignment[]): DealAssignment[] {
  const normalized = assignments.map((item) => ({ ...item }))
  for (const kind of ["originator", "closer"] as const) {
    const group = normalized.filter((item) => item.kind === kind)
    const primary = group.find((item) => item.isPrimary) ?? group[0]
    if (primary) {
      for (const item of group) item.isPrimary = item.id === primary.id
    }
  }
  return normalized
}
