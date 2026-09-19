import "server-only"

let underwritingNowOverride: Date | undefined

export function setUnderwritingNowForTests(now?: Date): void {
  underwritingNowOverride = now
}

function resolveNow(now?: Date): Date {
  return now ?? underwritingNowOverride ?? new Date()
}

function calendarYearMonth(instant: Date, timeZone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(instant)
  const year = Number(parts.find((part) => part.type === "year")?.value)
  const month = Number(parts.find((part) => part.type === "month")?.value)
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Unable to resolve calendar month for timezone ${timeZone}`)
  }
  return { year, month }
}

/** Last `count` fully closed calendar months in `timeZone`. Never includes the current month. */
export function closedLookbackMonths(count: number, timeZone: string, now?: Date): string[] {
  if (!Number.isInteger(count) || count <= 0) return []
  const { year, month } = calendarYearMonth(resolveNow(now), timeZone)
  const periods: string[] = []
  for (let offset = count; offset >= 1; offset -= 1) {
    const absolute = year * 12 + (month - 1) - offset
    const lookbackYear = Math.floor(absolute / 12)
    const lookbackMonth = (absolute % 12) + 1
    periods.push(`${lookbackYear}-${String(lookbackMonth).padStart(2, "0")}`)
  }
  return periods
}
