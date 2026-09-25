import test from "node:test"
import assert from "node:assert/strict"
import * as XLSX from "xlsx"
import { parseSpreadsheet } from "../src/lib/mca/imports/parser"

function workbook(format: "xlsx" | "xls", rows: unknown[][]): Uint8Array {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Leads")
  return XLSX.write(book, { type: "buffer", bookType: format })
}

test("CSV and Excel imports accept 1,000 leads and reject a larger batch", () => {
  for (const format of ["csv", "xlsx", "xls"] as const) {
    const rows = [["Business Name", "Monthly Revenue"], ...Array.from({ length: 1_000 }, (_, index) => [`Lead ${index + 1}`, index + 1])]
    const bytes = format === "csv" ? Buffer.from(rows.map((row) => row.join(",")).join("\n")) : workbook(format, rows)
    const parsed = parseSpreadsheet({ filename: `leads.${format}`, bytes })
    assert.equal(parsed.rows.length, 1_000)
    assert.equal(parsed.rows[999][0], "Lead 1000")
    const tooMany = [...rows, ["Lead 1001", 1001]]
    const extra = format === "csv" ? Buffer.from(tooMany.map((row) => row.join(",")).join("\n")) : workbook(format, tooMany)
    assert.throws(() => parseSpreadsheet({ filename: `leads.${format}`, bytes: extra }), /1,000 rows/)
  }
})

test("Excel parser rejects broken workbook content", () => {
  assert.throws(() => parseSpreadsheet({ filename: "bad.xlsx", bytes: Buffer.from("not an Excel file") }), /spreadsheet|Excel/i)
})
