import "server-only"

import { canActorAccessDeal } from "../deals/access-policy"
import type { DealActor, DealAssignment } from "../deals/schema"
import { AppError } from "../errors"
import { nowIso } from "../db"
import { HOME_SLA_HOURS, type HomeDealPanel, type HomePanelAssignment, type HomeQueueQuery, type HomeQueueResult } from "./contracts"

function accessAssignments(assignments: HomePanelAssignment[]): DealAssignment[] {
  return assignments.map((item) => ({
    id: item.membershipId,
    membershipId: item.membershipId,
    kind: item.kind,
    isPrimary: item.isPrimary,
    assignedAt: "",
    assignedByUserId: null,
  }))
}
import { countHomeCategories, deriveHomeReasons, sortHomeQueueItems, toHomeDealPanel, toHomeQueueItem } from "./derive"
import { loadHomeWorkspace } from "./query"

export async function getHomeNeedsActionQueue(actor: DealActor, query: HomeQueueQuery): Promise<HomeQueueResult> {
  const snapshot = await loadHomeWorkspace(actor.workspaceId)
  const items = []
  for (const facts of snapshot.facts.values()) {
    if (!canActorAccessDeal(actor, { workspaceId: actor.workspaceId, assignments: accessAssignments(facts.assignments) })) continue
    const reasons = deriveHomeReasons(facts, query.nowIso)
    const item = toHomeQueueItem(facts, reasons)
    if (!item) continue
    if (query.category && item.category !== query.category) continue
    items.push(item)
  }
  const sorted = sortHomeQueueItems(items)
  return {
    refreshedAt: query.nowIso,
    now: query.nowIso,
    slaHours: HOME_SLA_HOURS,
    items: sorted,
    counts: countHomeCategories(sorted),
  }
}

export async function getHomeDealPanel(actor: DealActor, dealId: string, now = nowIso()): Promise<HomeDealPanel> {
  const snapshot = await loadHomeWorkspace(actor.workspaceId)
  const facts = snapshot.facts.get(dealId)
  if (!facts || !canActorAccessDeal(actor, { workspaceId: actor.workspaceId, assignments: accessAssignments(facts.assignments) })) {
    throw new AppError(404, "deal_not_found", "The requested deal was not found.")
  }
  return toHomeDealPanel(facts, deriveHomeReasons(facts, now), now)
}
