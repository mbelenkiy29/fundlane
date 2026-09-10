import { createHash } from "node:crypto"
import type { ExportField } from "./contracts"

const FORMULA_PREFIX = /^[=+\-@\t\r\n]/

export function csvEscape(value: string | number | null | undefined, options: { identifier?: boolean } = {}): string {
  if (value === null || value === undefined) return ""
  let text = typeof value === "number" && Number.isFinite(value) && !options.identifier ? String(value) : String(value)
  if (options.identifier && text) text = `\t${text}`
  if (FORMULA_PREFIX.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) return `"${text.split('"').join('""')}"`
  return text
}

export function serializeCsv(
  fields: readonly ExportField[],
  rows: ReadonlyArray<Readonly<Record<string, string | number | null>>>,
): string {
  const header = fields.map((field) => csvEscape(field.header)).join(",")
  const body = rows.map((row) => fields.map((field) => csvEscape(row[field.key], { identifier: field.identifier })).join(","))
  return [header, ...body].join("\r\n")
}

export function csvChecksum(csv: string): string {
  return createHash("sha256").update(csv, "utf8").digest("hex")
}

export function parseCsvRowCount(csv: string): number {
  if (!csv) return 0
  const lines = csv.split("\r\n")
  return Math.max(0, lines.length - 1)
}
