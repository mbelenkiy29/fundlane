import { addDate, dateInZone, localToIso, type ActivityKind } from "../calendar/contracts"
import { HOME_REASON_LABELS, type HomeActionReasonCode } from "../home/contracts"

export const CALENDAR_PLAN_LIMIT = 10
export const CALENDAR_PLAN_LIST_LIMIT = 20

export function calendarPlanMarker(dealId: string, reason: HomeActionReasonCode): string {
  return `assistant-plan:v1:${dealId}:${reason}`
}

export function suggestionForReason(input: {
  dealId: string
  legalName: string
  reason: HomeActionReasonCode
}): { kind: ActivityKind; title: string; marker: string } {
  const kind: ActivityKind = input.reason === "submit" || input.reason === "resubmit" ? "submission_task" : "followup"
  const label = HOME_REASON_LABELS[input.reason].own_action
  const name = input.legalName.trim() || "deal"
  return {
    kind,
    title: `${label} — ${name}`.slice(0, 240),
    marker: calendarPlanMarker(input.dealId, input.reason),
  }
}

export interface CalendarPlanCandidate {
  dealId: string
  legalName: string
  reason: HomeActionReasonCode
}

export function candidatesFromQueue(
  items: Array<{ dealId: string; legalName: string; reasons: Array<{ code: HomeActionReasonCode }> }>,
  dealId?: string | null,
): CalendarPlanCandidate[] {
  const scoped = dealId ? items.filter((item) => item.dealId === dealId) : items
  const candidates: CalendarPlanCandidate[] = []
  for (const item of scoped) {
    for (const reason of item.reasons) {
      candidates.push({ dealId: item.dealId, legalName: item.legalName, reason: reason.code })
      if (candidates.length >= CALENDAR_PLAN_LIST_LIMIT) return candidates
    }
  }
  return candidates
}

export interface CalendarPlanBusy {
  start: string
  end: string
}

export interface CalendarPlanSlot {
  dealId: string
  reason: HomeActionReasonCode
  kind: ActivityKind
  title: string
  start: string
  end: string
  timezone: string
  allDay: false
  notes: string
  marker: string
}

export function allocateCalendarSlots(input: {
  items: CalendarPlanCandidate[]
  timezone: string
  now: Date
  busy: CalendarPlanBusy[]
  existingMarkers: Set<string>
  limit?: number
}): CalendarPlanSlot[] {
  const limit = input.limit ?? CALENDAR_PLAN_LIMIT
  const slots: CalendarPlanSlot[] = []
  let cursor = nextWeekdayMorning(input.now, input.timezone)
  const occupied = [...input.busy]
  for (const item of input.items) {
    if (slots.length >= limit) break
    const suggestion = suggestionForReason(item)
    if (input.existingMarkers.has(suggestion.marker)) continue
    cursor = skipCollisions(cursor, occupied, input.timezone)
    const start = cursor
    const end = new Date(Date.parse(start) + 30 * 60_000).toISOString()
    const slot: CalendarPlanSlot = {
      dealId: item.dealId,
      reason: item.reason,
      kind: suggestion.kind,
      title: suggestion.title,
      start,
      end,
      timezone: input.timezone,
      allDay: false,
      notes: suggestion.marker,
      marker: suggestion.marker,
    }
    slots.push(slot)
    occupied.push({ start, end })
    input.existingMarkers.add(suggestion.marker)
    cursor = new Date(Date.parse(start) + 60 * 60_000).toISOString()
  }
  return slots
}

function nextWeekdayMorning(now: Date, timezone: string): string {
  let day = addDate(dateInZone(now, timezone), 1)
  while (weekend(day, timezone)) day = addDate(day, 1)
  return localToIso(`${day}T09:00`, timezone) ?? `${day}T13:00:00.000Z`
}

function weekend(date: string, timezone: string): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(
    new Date(`${date}T12:00:00.000Z`),
  )
  return weekday === "Sat" || weekday === "Sun"
}

function skipCollisions(start: string, busy: CalendarPlanBusy[], timezone: string): string {
  let cursor = start
  for (let i = 0; i < 48; i++) {
    const end = new Date(Date.parse(cursor) + 30 * 60_000).toISOString()
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date(cursor)),
    )
    const day = dateInZone(cursor, timezone)
    if (localHour >= 17 || weekend(day, timezone)) {
      cursor = nextWeekdayMorning(new Date(Date.parse(cursor) - 60_000), timezone)
      continue
    }
    const hit = busy.some((block) => block.start < end && block.end > cursor)
    if (!hit) return cursor
    cursor = new Date(Date.parse(cursor) + 60 * 60_000).toISOString()
  }
  return cursor
}
