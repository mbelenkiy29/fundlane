/** Billing projections store integer cents. Never combine totals across currencies. */
export function formatBillingMoney(cents: number | string, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(Number(cents) / 100)
}
export function validSelectedSeats(value: number) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 100000
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
