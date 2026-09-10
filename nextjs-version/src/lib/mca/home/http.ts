import "server-only"

import { requireWorkspaceAccess } from "../auth"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { getWorkspaceSettings } from "../workspaces"
import { isHomeActionCategory, type HomeQueueQuery } from "./contracts"

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

export async function requireHomeActor(request: Request): Promise<DealActor> {
  const context = await requireWorkspaceAccess(request, { scopes: ["deals:read"] })
  if (context.authType === "session") {
    const settings = await getWorkspaceSettings(context.workspaceId)
    if (!settings.pageVisibility.dashboard && !settings.pageVisibility.deals) {
      throw new AppError(403, "page_disabled", "Home and deals are disabled for this workspace.")
    }
  }
  return { ...await actorForDeals(context), correlationId: requestCorrelationId(request) }
}

export function parseHomeQueueQuery(search: URLSearchParams, fallbackNow: string): HomeQueueQuery {
  const now = search.get("now")?.trim() || fallbackNow
  if (!ISO.test(now) || Number.isNaN(Date.parse(now))) {
    throw new AppError(422, "invalid_filter", "now must be a UTC ISO-8601 timestamp.", { now: ["Use a UTC timestamp such as 2026-01-15T12:00:00.000Z."] })
  }
  const category = search.get("category")?.trim()
  if (category && !isHomeActionCategory(category)) {
    throw new AppError(422, "invalid_filter", "category must be own_action, overdue_waiting, or renewal.", { category: ["Choose own_action, overdue_waiting, or renewal."] })
  }
  return { nowIso: now, ...(category && isHomeActionCategory(category) ? { category } : {}) }
}
