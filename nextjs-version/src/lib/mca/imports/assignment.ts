import { AppError } from "../errors"
import type { DealActor } from "../deals/schema"
import { permittedAssignmentIds } from "../deals/access-policy"

export function validateAssignmentPool(actor: DealActor, pool: string[]): string[] {
  const allowed = permittedAssignmentIds(actor)
  const unique = [...new Set(pool.filter(Boolean))]
  for (const id of unique) {
    if (!actor.activeMembershipIds.includes(id)) throw new AppError(422, "inactive_assignee", "The assignment preview includes a member who is no longer active.")
    if (!allowed.has(id)) throw new AppError(403, "assignment_not_allowed", "The assignment pool includes a member outside your assignment scope.")
  }
  return unique
}

export function roundRobinAssignments(rows: Array<{ explicitOriginator?: string }>, pool: string[]): Array<string | null> {
  let cursor = 0
  return rows.map((row) => {
    if (row.explicitOriginator) return row.explicitOriginator
    if (!pool.length) return null
    const assigned = pool[cursor % pool.length]
    cursor += 1
    return assigned
  })
}
