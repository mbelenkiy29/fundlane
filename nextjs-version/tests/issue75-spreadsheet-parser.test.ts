import test from "node:test"
import assert from "node:assert/strict"
import * as XLSX from "xlsx"
import { parseSpreadsheet } from "../src/lib/mca/imports/parser"

function workbook(format: "xlsx" | "xls", rows: unknown[][]): Uint8Array {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Leads")
  return XLSX.write(book, { type: "buffer", bookType: format })
}

test("CSV and Excel imports accept 10,000 leads and reject 10,001", () => {
  const rows = [["Business Name", "Monthly Revenue"], ...Array.from({ length: 10_001 }, (_, index) => [`Lead ${index + 1}`, index + 1])]
  for (const format of ["csv", "xlsx", "xls"] as const) {
    const accepted = rows.slice(0, 10_001)
    const bytes = format === "csv" ? Buffer.from(accepted.map((row) => row.join(",")).join("\n")) : workbook(format, accepted)
    const parsed = parseSpreadsheet({ filename: `leads.${format}`, bytes })
    assert.equal(parsed.rows.length, 10_000)
    assert.equal(parsed.rows[9_999][0], "Lead 10000")
    const extra = format === "csv" ? Buffer.from(rows.map((row) => row.join(",")).join("\n")) : workbook(format, rows)
    assert.throws(() => parseSpreadsheet({ filename: `leads.${format}`, bytes: extra }), /10,000 rows/)
  }
})

test("XLSX rejects rows beyond the capped workbook read", () => {
  const rows = [["Business Name"], ...Array.from({ length: 10_021 }, (_, index) => [`Lead ${index + 1}`])]
  assert.throws(() => parseSpreadsheet({ filename: "oversized.xlsx", bytes: workbook("xlsx", rows) }), /10,000 rows/)
})

test("Excel parser rejects broken workbook content", () => {
  assert.throws(() => parseSpreadsheet({ filename: "bad.xlsx", bytes: Buffer.from("not an Excel file") }), /spreadsheet|Excel/i)
})
