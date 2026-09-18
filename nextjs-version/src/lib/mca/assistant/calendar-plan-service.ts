import "server-only"
import { decryptSensitive } from "../crypto"
import { AppError } from "../errors"
import { getDatabase, nowIso } from "../db"
import type { DealActor } from "../deals/schema"
import { saveActivity } from "../calendar/service"
import { getHomeNeedsActionQueue } from "../home/service"
import {
  CALENDAR_PLAN_LIMIT,
  allocateCalendarSlots,
  candidatesFromQueue,
  suggestionForReason,
  type CalendarPlanSlot,
} from "./calendar-plan"

export interface PerformanceActionView {
  dealId: string
  legalName: string
  reason: string
  category: string
  label: string
  href: string
  suggestedKind: string
  suggestedTitle: string
  marker: string
}

export async function listPerformanceActions(actor: DealActor, dealId?: string | null) {
  const queue = await getHomeNeedsActionQueue(actor, { nowIso: nowIso() })
  const items = dealId ? queue.items.filter((item) => item.dealId === dealId) : queue.items
  return {
    retrievedAt: queue.refreshedAt,
    calendarUrl: "/calendar",
    total: items.length,
    truncated: items.length > 20,
    actions: items.slice(0, 20).flatMap((item) =>
      item.reasons.map((reason) => {
        const suggestion = suggestionForReason({
          dealId: item.dealId,
          legalName: item.legalName,
          reason: reason.code,
        })
        return {
          dealId: item.dealId,
          legalName: item.legalName,
          reason: reason.code,
          category: reason.category,
          label: reason.label,
          href: `/pipeline?deal=${encodeURIComponent(item.dealId)}&tab=schedule`,
          suggestedKind: suggestion.kind,
          suggestedTitle: suggestion.title,
          marker: suggestion.marker,
        } satisfies PerformanceActionView
      }),
    ),
  }
}

export async function draftCalendarPlan(
  actor: DealActor,
  options: { dealId?: string | null; now?: Date } = {},
) {
  const queue = await getHomeNeedsActionQueue(actor, { nowIso: (options.now ?? new Date()).toISOString() })
  const candidates = candidatesFromQueue(queue.items, options.dealId)
  const timezone = (await getDatabase().prepare<{ timezone: string }>("SELECT timezone FROM workspaces WHERE id=?").get(actor.workspaceId))?.timezone
    ?? "America/New_York"
  const windowStart = new Date((options.now ?? new Date()).getTime() - 86400000).toISOString()
  const windowEnd = new Date((options.now ?? new Date()).getTime() + 21 * 86400000).toISOString()
  const rows = await getDatabase()
    .prepare<{ deal_id: string; starts_at: string; ends_at: string; notes_cipher: string | null }>(
      `SELECT deal_id, starts_at, ends_at, notes_cipher FROM mca_calendar_activities
       WHERE workspace_id=? AND assignee_id=? AND status='scheduled' AND starts_at<? AND ends_at>?`,
    )
    .all(actor.workspaceId, actor.membershipId, windowEnd, windowStart)
  const existingMarkers = new Set<string>()
  const busy = rows.map((row) => {
    const notes = row.notes_cipher ? decryptSensitive(row.notes_cipher, actor.workspaceId) : ""
    const match = notes.match(/assistant-plan:v1:[^:\s]+:[a-z_]+/)
    if (match) existingMarkers.add(match[0])
    return { start: row.starts_at, end: row.ends_at }
  })
  const items = allocateCalendarSlots({
    items: candidates,
    timezone,
    now: options.now ?? new Date(),
    busy,
    existingMarkers,
    limit: CALENDAR_PLAN_LIMIT,
  })
  return { timezone, items, skipped: candidates.length - items.length }
}

export async function applyCalendarPlan(actor: DealActor, items: CalendarPlanSlot[]) {
  if (!actor.membershipId) {
    throw new AppError(403, "assignee_forbidden", "Choose an authorized active assignee.")
  }
  const created = []
  for (const item of items) {
    const event = await saveActivity(actor, {
      dealId: item.dealId,
      assigneeId: actor.membershipId,
      kind: item.kind,
      title: item.title,
      start: item.start,
      end: item.end,
      allDay: false,
      timezone: item.timezone,
      notes: item.notes,
      status: "scheduled",
    })
    created.push({
      id: event.id,
      dealId: item.dealId,
      title: event.title,
      start: event.start,
      href: event.href ?? `/calendar`,
    })
  }
  return { created: created.length, events: created, calendarUrl: "/calendar" }
}
