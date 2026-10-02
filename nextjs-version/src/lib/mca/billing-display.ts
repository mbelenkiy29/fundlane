/** Billing projections store integer cents. Never combine totals across currencies. */
export function formatBillingMoney(cents: number | string, currency = "usd") {
  if (typeof cents === "number" && !Number.isSafeInteger(cents)) throw new Error("Billing cents must be a safe integer")
  const value = BigInt(cents), absolute = value < BigInt(0) ? -value : value
  const decimal = `${value < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`
  // ECMA-402 accepts exact decimal strings; TS still declares only number/bigint.
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(decimal as unknown as number)
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
