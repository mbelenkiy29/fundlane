import "server-only"

import { extname } from "node:path"
import iconv from "iconv-lite"
import * as XLSX from "xlsx"
import { AppError } from "../errors"
import type { ImportFormat, ParsedSpreadsheet } from "./contracts"

const MAX_ROWS = 10_000
const MAX_COLUMNS = 200
const MAX_FILE_BYTES = 25 * 1024 * 1024

function formatFor(filename: string): ImportFormat {
  const extension = extname(filename).toLowerCase().slice(1)
  if (["csv", "tsv", "xlsx", "xls"].includes(extension)) return extension as ImportFormat
  throw new AppError(422, "unsupported_import_format", "Choose a CSV, TSV, XLSX, or XLS spreadsheet.")
}

function decodeText(bytes: Uint8Array): { text: string; encoding: string; warnings: string[] } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: iconv.decode(Buffer.from(bytes.subarray(2)), "utf16-le"), encoding: "utf-16le", warnings: [] }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: iconv.decode(Buffer.from(bytes.subarray(2)), "utf16-be"), encoding: "utf-16be", warnings: [] }
  const content = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(content), encoding: "utf-8", warnings: [] }
  } catch {
    const text = iconv.decode(Buffer.from(content), "windows-1252")
    return { text, encoding: "windows-1252", warnings: ["The file was decoded as Windows-1252. Review accented characters before commit."] }
  }
}

function cleanCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).replace(/\u0000/g, "").trim()
}

function chooseHeader(rows: string[][]): number {
  let bestIndex = 0
  let bestScore = -1
  for (let index = 0; index < Math.min(rows.length, 20); index += 1) {
    const cells = rows[index].map((cell) => cell.trim()).filter(Boolean)
    const unique = new Set(cells.map((cell) => cell.toLocaleLowerCase()))
    const nextWidth = rows[index + 1]?.filter(Boolean).length ?? 0
    const score = unique.size * 3 + Math.min(nextWidth, unique.size) - (cells.length - unique.size) * 5
    if (cells.length >= 2 && score > bestScore) { bestIndex = index; bestScore = score }
  }
  return bestIndex
}

function uniqueHeaders(row: string[]): { headers: string[]; warning?: string } {
  const seen = new Map<string, number>()
  let changed = false
  const headers = row.map((raw, index) => {
    const base = raw.trim() || `Column ${index + 1}`
    const key = base.toLocaleLowerCase()
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count > 1) changed = true
    return count === 1 ? base : `${base} (${count})`
  })
  return { headers, ...(changed ? { warning: "Duplicate header names were given stable suffixes." } : {}) }
}

export function parseSpreadsheet(input: { filename: string; bytes: Uint8Array }): ParsedSpreadsheet {
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_FILE_BYTES) throw new AppError(422, "import_file_size", "Import files must contain data and be no larger than 25 MiB.")
  const format = formatFor(input.filename)
  let workbook: XLSX.WorkBook
  let encoding = "binary"
  const warnings: string[] = []
  try {
    if (format === "csv" || format === "tsv") {
      const decoded = decodeText(input.bytes)
      encoding = decoded.encoding
      warnings.push(...decoded.warnings)
      workbook = XLSX.read(decoded.text, { type: "string", raw: false, FS: format === "tsv" ? "\t" : undefined })
    } else {
      workbook = XLSX.read(input.bytes, { type: "array", cellDates: true, dense: true })
    }
  } catch {
    throw new AppError(422, "spreadsheet_parse_failed", "The spreadsheet could not be read. Confirm that the file is not encrypted or corrupted.")
  }
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw new AppError(422, "spreadsheet_empty", "The spreadsheet does not contain a worksheet.")
  const matrix = (XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false }) as unknown[][])
    .map((row) => row.slice(0, MAX_COLUMNS).map(cleanCell))
    .filter((row) => row.some(Boolean))
  if (!matrix.length) throw new AppError(422, "spreadsheet_empty", "The spreadsheet does not contain any rows.")
  if (matrix.length > MAX_ROWS + 20) throw new AppError(422, "spreadsheet_row_limit", `Import at most ${MAX_ROWS.toLocaleString()} rows per run.`)
  const headerRow = chooseHeader(matrix)
  const deduped = uniqueHeaders(matrix[headerRow])
  if (deduped.warning) warnings.push(deduped.warning)
  const rows = matrix.slice(headerRow + 1, headerRow + 1 + MAX_ROWS).map((row) => deduped.headers.map((_, index) => row[index] ?? ""))
  if (!rows.length) throw new AppError(422, "spreadsheet_no_data", "The spreadsheet has headers but no data rows.")
  if (workbook.SheetNames.length > 1) warnings.push(`Imported the first worksheet (${sheetName}); ${workbook.SheetNames.length - 1} additional worksheet(s) were not staged.`)
  return { format, encoding, sheetName, headerRow: headerRow + 1, headers: deduped.headers, rows, warnings }
}
