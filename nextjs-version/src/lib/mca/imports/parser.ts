import "server-only"

import { extname } from "node:path"
import iconv from "iconv-lite"
import { AppError } from "../errors"
import type { ImportFormat, ParsedSpreadsheet } from "./contracts"

const MAX_ROWS = 10_000
const MAX_COLUMNS = 200
const MAX_FILE_BYTES = 25 * 1024 * 1024

function formatFor(filename: string): ImportFormat {
  const extension = extname(filename).toLowerCase().slice(1)
  if (extension === "csv") return "csv"
  throw new AppError(422, "unsupported_import_format", "Choose a CSV file. Export Excel or Google Sheets as CSV first.")
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

/** Parse CSV as text only. Never invoke workbook, HTML, or formula interpreters. */
function csvRows(text: string): string[][] {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new AppError(422, "csv_binary_content", "The file contains binary data. Export a plain-text CSV file.")
  const rows: string[][] = []
  let row: string[] = [], cell = "", quoted = false, closed = false
  const finishCell = () => {
    row.push(cleanCell(cell)); cell = ""; closed = false
    if (row.length > MAX_COLUMNS) throw new AppError(422, "spreadsheet_column_limit", `Import at most ${MAX_COLUMNS} columns.`)
  }
  const finishRow = () => {
    finishCell()
    if (row.some(Boolean)) rows.push(row)
    row = []
    if (rows.length > MAX_ROWS + 20) throw new AppError(422, "spreadsheet_row_limit", `Import at most ${MAX_ROWS.toLocaleString()} rows per run.`)
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ }
        else { quoted = false; closed = true }
      } else cell += char
    } else if (char === ",") finishCell()
    else if (char === "\n" || char === "\r") { finishRow(); if (char === "\r" && text[i + 1] === "\n") i++ }
    else if (char === '"' && !cell && !closed) quoted = true
    else if (char === '"' || (closed && char !== " " && char !== "\t")) throw new AppError(422, "csv_invalid_quotes", "The CSV contains invalid quotes. Export it again as CSV.")
    else if (!closed) cell += char
  }
  if (quoted) throw new AppError(422, "csv_invalid_quotes", "A quoted CSV value is incomplete.")
  if (cell || closed || row.length) finishRow()
  return rows
}

export function parseSpreadsheet(input: { filename: string; bytes: Uint8Array }): ParsedSpreadsheet {
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_FILE_BYTES) throw new AppError(422, "import_file_size", "Import files must contain data and be no larger than 25 MiB.")
  const format = formatFor(input.filename)
  const decoded = decodeText(input.bytes)
  const matrix = csvRows(decoded.text)
  if (!matrix.length) throw new AppError(422, "spreadsheet_empty", "The CSV does not contain any rows.")
  const headerRow = chooseHeader(matrix)
  const deduped = uniqueHeaders(matrix[headerRow])
  const warnings = [...decoded.warnings]
  if (deduped.warning) warnings.push(deduped.warning)
  const data = matrix.slice(headerRow + 1)
  if (data.length > MAX_ROWS) throw new AppError(422, "spreadsheet_row_limit", `Import at most ${MAX_ROWS.toLocaleString()} rows per run.`)
  if (!data.length) throw new AppError(422, "spreadsheet_no_data", "The CSV has headers but no data rows.")
  if (data.some(row => row.length > deduped.headers.length)) throw new AppError(422, "csv_row_width", "A CSV row contains more values than the header. Check commas and quoted values.")
  const rows = data.map(row => deduped.headers.map((_, index) => row[index] ?? ""))
  return { format, encoding: decoded.encoding, sheetName: "CSV", headerRow: headerRow + 1, headers: deduped.headers, rows, warnings }
}
