export function formatCents(cents: number | null): string {
  if (cents === null) return "Unknown"
  const sign = cents < 0 ? "-" : ""
  const absolute = Math.abs(cents)
  return `${sign}$${Math.floor(absolute / 100).toLocaleString("en-US")}.${String(absolute % 100).padStart(2, "0")}`
}

/** Date-only business values have no timezone and must never shift a calendar day. */
export function formatMcaDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number)
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)))
  }
  return new Date(value).toLocaleDateString()
}
