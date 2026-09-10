import "server-only"

import { AppError } from "../errors"
import { parseSpreadsheet } from "../imports/parser"
import type { HistoricalFundingRowInput } from "./contracts"

const key = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
const integer = (value: string, field: string, optional = false): number | undefined => {
  if (!value.trim() && optional) return undefined
  if (!/^\d+$/.test(value.trim())) throw new AppError(422, "historical_parse_failed", `${field} must contain whole cents.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new AppError(422, "historical_parse_failed", `${field} is outside the supported range.`)
  return parsed
}
const decimal = (value: string): number | undefined => value.trim() ? Number(value.trim()) : undefined

export function parseHistoricalSpreadsheet(input: { filename: string; bytes: Uint8Array }): HistoricalFundingRowInput[] {
  const parsed = parseSpreadsheet(input)
  const headers = parsed.headers.map(key)
  const rows = parsed.rows.map((cells, index) => {
    const item = Object.fromEntries(headers.map((header, cell) => [header, cells[cell] ?? ""]))
    try {
      return {
        externalId: item.external_id,
        dealId: item.deal_id || undefined,
        legalName: item.legal_name || undefined,
        funderId: item.funder_id || undefined,
        funderName: item.funder_name,
        fundedAt: item.funded_at,
        amountCents: integer(item.amount_cents, "amount_cents")!,
        factorRate: decimal(item.factor_rate),
        termMonths: integer(item.term_months, "term_months", true),
        paymentAmountCents: integer(item.payment_amount_cents, "payment_amount_cents", true),
        paymentCount: integer(item.payment_count, "payment_count", true),
        paymentFrequency: item.payment_frequency as HistoricalFundingRowInput["paymentFrequency"] || undefined,
        calendarConvention: item.calendar_convention as HistoricalFundingRowInput["calendarConvention"] || undefined,
        commissionCents: integer(item.commission_cents, "commission_cents", true),
        paidCommissionCents: integer(item.paid_commission_cents, "paid_commission_cents", true),
        paidCommissionAt: item.paid_commission_at || undefined,
        feeCents: integer(item.fee_cents, "fee_cents", true),
        expectedCommissionAt: item.expected_commission_at || undefined,
        expectedFeeAt: item.expected_fee_at || undefined,
        splits: item.splits_json ? JSON.parse(item.splits_json) : undefined,
        paidSplits: item.paid_splits_json ? JSON.parse(item.paid_splits_json) : undefined,
      } satisfies HistoricalFundingRowInput
    } catch (error) {
      throw new AppError(422, "historical_parse_failed", `Row ${parsed.headerRow + index + 1}: ${error instanceof Error ? error.message : "could not be parsed"}`)
    }
  })
  return rows
}
