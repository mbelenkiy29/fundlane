import { z } from "zod"

export const ACTIVITY_KINDS = ["call", "followup", "submission_task"] as const
export type ActivityKind = typeof ACTIVITY_KINDS[number]
export type CalendarKind = ActivityKind | "automated_followup" | "submission" | "google"
export const activitySchema = z.object({
  dealId: z.string().min(1).max(100),
  assigneeId: z.string().min(1).max(100),
  kind: z.enum(ACTIVITY_KINDS),
  title: z.string().trim().min(1).max(240),
  start: z.string().min(10).max(40),
  end: z.string().min(10).max(40),
  allDay: z.boolean(),
  timezone: z.string().max(80).refine(validTimezone, "Choose a valid timezone."),
  notes: z.string().max(5000).default(""),
  status: z.enum(["scheduled", "completed", "cancelled"]).default("scheduled"),
  version: z.number().int().positive().optional(),
}).strict().superRefine((value, ctx) => {
  const valid = value.allDay
    ? validDate(value.start) && validDate(value.end)
    : /^\d{4}-\d\d-\d\dT/.test(value.start) && /(?:Z|[+-]\d\d:\d\d)$/.test(value.start) && /(?:Z|[+-]\d\d:\d\d)$/.test(value.end)
      && Number.isFinite(Date.parse(value.start)) && Number.isFinite(Date.parse(value.end))
  if (!valid || value.end <= value.start && value.allDay || Date.parse(value.end) <= Date.parse(value.start)) {
    ctx.addIssue({ code: "custom", path: ["end"], message: "Use valid dates with the end after the start. All-day end dates are exclusive." })
  }
})
export type ActivityInput = z.infer<typeof activitySchema>
export interface CalendarEvent {
  id: string
  kind: CalendarKind
  title: string
  start: string
  end: string
  allDay: boolean
  timezone: string
  status: string
  editable: boolean
  dealId?: string
  dealName?: string
  assigneeId?: string
  notes?: string
  version?: number
  href?: string
  conflict?: { etag: string; title: string; start: string; end: string; reason?: string }
}
export interface CalendarFeed {
  events: CalendarEvent[]
  deals: { id: string; name: string; assigneeIds: string[] }[]
  assignees: { id: string; name: string }[]
  membershipId: string
  canViewTeam: boolean
  timezone: string
}
export interface GoogleConnectionView {
  configured: boolean
  enabled: boolean
  connected: boolean
  email?: string
  status?: string
  lastSync?: string
  error?: string
  calendars: { id: string; name: string; selected: boolean }[]
}
export function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return Boolean(value) } catch { return false }
}
export function validDate(value: string): boolean {
  return /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}
export function dateInZone(value: string | Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value))
  return ["year", "month", "day"].map(type => parts.find(p => p.type === type)?.value).join("-")
}
export function addDate(value: string, days: number): string {
  return new Date(Date.parse(value + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10)
}
/** Resolve a wall-clock input explicitly, including rejecting DST gaps. */
export function localToIso(value: string, timezone: string, originalIso?: string): string | undefined {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) || !validTimezone(timezone) || !validDate(value.slice(0, 10))) return undefined
  // Preserve the selected occurrence of an ambiguous fall-back time on an unchanged edit.
  if (originalIso && Number.isFinite(Date.parse(originalIso))) {
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(originalIso))
    if (`${dateInZone(originalIso, timezone)}T${time}` === value) return new Date(originalIso).toISOString()
  }
  const target = Date.parse(value + ":00Z")
  let ms = target
  for (let i = 0; i < 8; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))
    const read = (type: string) => parts.find(p => p.type === type)?.value
    const wall = `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}`
    if (wall === value) return new Date(ms).toISOString()
    ms += target - Date.parse(wall + ":00Z")
  }
  return undefined
}
