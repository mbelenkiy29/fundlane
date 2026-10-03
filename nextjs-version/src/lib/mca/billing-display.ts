/** Billing projections store integer cents. Never combine totals across currencies. */
export function formatBillingMoney(cents: number | string, currency = "usd") {
  if (typeof cents === "number" && !Number.isSafeInteger(cents)) throw new Error("Billing cents must be a safe integer")
  const value = BigInt(cents), absolute = value < BigInt(0) ? -value : value
  const decimal = `${value < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`
  // ECMA-402 accepts exact decimal strings; TS still declares only number/bigint.
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(decimal as unknown as number)
}
/** A stored IANA time zone this runtime recognizes, otherwise undefined (callers fall back to the viewer's zone). */
export function billingTimeZone(value: string | null | undefined): string | undefined {
  const zone = value?.trim()
  if (!zone) return undefined
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return zone } catch { return undefined }
}
/**
 * A billing timestamp such as the trial end, always labeled with its zone. Uses the company's time zone
 * when one is stored and valid; otherwise the runtime's own zone (the viewer's browser on the client).
 */
export function formatBillingDate(value: string, timeZone?: string | null) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: billingTimeZone(timeZone) }).format(date)
}
export function validSelectedSeats(value: number) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 100000
}
export function quotedSeatIncrease(preview: { selectedSeats: number; prorationAmount: number | null } | null, selectedSeats: number) {
  return preview?.selectedSeats === selectedSeats && Number.isSafeInteger(preview.prorationAmount)
}
export type BillingRecovery = {
  overdueAmount: number;
  paymentRequired: boolean;
  verificationPending: boolean;
  invoices: Array<{
    id: string;
    status: string;
    amountRemaining: number;
    periodStart: string;
    periodEnd: string;
    hostedInvoiceUrl: string | null;
  }>;
}
