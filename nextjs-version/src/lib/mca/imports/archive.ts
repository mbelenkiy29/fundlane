import "server-only"

import { basename, extname } from "node:path"
import yauzl, { type Entry, type ZipFile } from "yauzl"
import { AppError } from "../errors"
import type { ArchiveCategory, ArchiveEntryPreview, ImportRowPreview } from "./contracts"

const MAX_ARCHIVES = 10
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
const MAX_ENTRIES = 2_000
const MAX_ENTRY_BYTES = 25 * 1024 * 1024
const MAX_EXPANDED_BYTES = 250 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 1_000

export function normalizedMerchantName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\b(llc|inc|corp|ltd)\.?$/i, "").replace(/[^a-z0-9]/g, "")
}

function safePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.startsWith("\\") || /^[a-z]:/i.test(value) || value.includes("\u0000")) return false
  return !value.split(/[\\/]+/).some((part) => part === ".." || part === "")
}

function isDirectory(entry: Entry): boolean { return entry.fileName.endsWith("/") }
function isSymlink(entry: Entry): boolean { return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000 }
function isNestedArchive(name: string): boolean { return /\.(zip|7z|rar|tar|tgz|gz|bz2|xz)$/i.test(name) }

function validateEntry(entry: Entry, archiveName: string): void {
  if (!safePath(entry.fileName)) throw new AppError(422, "unsafe_archive_path", `Unsafe ZIP path rejected in ${archiveName}.`)
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new AppError(422, "encrypted_archive_entry", `${entry.fileName} is encrypted and cannot be inspected safely.`)
  if (isSymlink(entry)) throw new AppError(422, "archive_symlink", `${entry.fileName} is a symbolic link and was rejected.`)
  if (isNestedArchive(entry.fileName)) throw new AppError(422, "nested_archive", `${entry.fileName} is a nested archive. Extract it and upload its contents separately.`)
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new AppError(422, "archive_entry_size", `${entry.fileName} exceeds the 25 MiB per-file limit.`)
  if (entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize > Math.max(1, entry.compressedSize) * MAX_COMPRESSION_RATIO) throw new AppError(422, "archive_compression_ratio", `${entry.fileName} has an unsafe compression ratio.`)
}

function openZip(input: Uint8Array): Promise<ZipFile> {
  return new Promise((resolve, reject) => yauzl.fromBuffer(Buffer.from(input), { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => error || !zip ? reject(error ?? new Error("Invalid ZIP")) : resolve(zip)))
}

async function walkZip(archive: { filename: string; bytes: Uint8Array }, visitor: (entry: Entry, zip: ZipFile) => Promise<void> | void): Promise<void> {
  if (extname(archive.filename).toLocaleLowerCase() !== ".zip") throw new AppError(422, "archive_format", `${archive.filename} is not a ZIP archive.`)
  if (!archive.bytes.byteLength || archive.bytes.byteLength > MAX_ARCHIVE_BYTES) throw new AppError(422, "archive_size", `${archive.filename} must be no larger than 25 MiB.`)
  let zip: ZipFile
  try { zip = await openZip(archive.bytes) } catch { throw new AppError(422, "archive_parse_failed", `${archive.filename} could not be read.`) }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => { if (settled) return; settled = true; zip.close(); if (error instanceof Error && /invalid relative path|absolute path/i.test(error.message)) reject(new AppError(422,"unsafe_archive_path",`Unsafe ZIP path rejected in ${archive.filename}.`)); else if (error) reject(error); else resolve() }
    zip.on("error", finish)
    zip.on("end", () => finish())
    zip.on("entry", (entry) => { Promise.resolve().then(() => visitor(entry, zip)).then(() => zip.readEntry(), finish) })
    zip.readEntry()
  })
}

export function inferArchiveCategory(path: string): ArchiveCategory {
  const name = basename(path).toLocaleLowerCase()
  if (/statement|bank[_ -]?(stmt|statement)/.test(name)) return "statement"
  if (/application|app[_ -]?(signed|form)/.test(name)) return "application"
  if (/void|check/.test(name)) return "voided_check"
  if (/driver|license|(^|[^a-z])dl([^a-z]|$)/.test(name)) return "driver_license"
  if (/closing|contract/.test(name)) return "closing_document"
  return "other_stip"
}

function folderFor(path: string): string { const parts = path.split(/[\\/]+/).filter(Boolean); return normalizedMerchantName(parts.length > 1 ? parts[0] : basename(path, extname(path))) }

export async function inspectArchives(archives: Array<{ filename: string; bytes: Uint8Array }>, rows: ImportRowPreview[]): Promise<ArchiveEntryPreview[]> {
  if (!archives.length || archives.length > MAX_ARCHIVES) throw new AppError(422, "archive_count", `Choose between 1 and ${MAX_ARCHIVES} ZIP archives.`)
  const rowNames = new Map<string, string[]>()
  for (const row of rows) { const name = normalizedMerchantName(row.application.legalName ?? row.application.dbaName ?? ""); if (name) rowNames.set(name, [...(rowNames.get(name) ?? []), row.id]) }
  const result: ArchiveEntryPreview[] = []; let expandedBytes = 0
  for (const archive of archives) await walkZip(archive, (entry) => {
    if (isDirectory(entry)) return
    validateEntry(entry, archive.filename)
    expandedBytes += entry.uncompressedSize
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_BYTES) throw new AppError(422, "archive_expansion_limit", "Expanded ZIP contents exceed the 250 MiB safety limit.")
    if (result.length >= MAX_ENTRIES) throw new AppError(422, "archive_entry_limit", `Archives may contain at most ${MAX_ENTRIES.toLocaleString()} files.`)
    const normalizedFolder = folderFor(entry.fileName); const candidateRowIds = rowNames.get(normalizedFolder) ?? []
    result.push({ archiveName: archive.filename, path: entry.fileName, normalizedFolder, byteLength: entry.uncompressedSize, category: inferArchiveCategory(entry.fileName), candidateRowIds, state: candidateRowIds.length === 1 ? "exact" : candidateRowIds.length > 1 ? "ambiguous" : "unmatched" })
  })
  return result
}

function readEntryBounded(zip: ZipFile, entry: Entry): Promise<Uint8Array> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) { reject(error ?? new Error("ZIP stream unavailable")); return }
    const chunks: Buffer[] = []; let total = 0
    stream.on("data", (chunk: Buffer) => { total += chunk.byteLength; if (total > MAX_ENTRY_BYTES || total > entry.uncompressedSize) { stream.destroy(new AppError(422, "archive_entry_size", `${entry.fileName} exceeded its declared safe size.`)); return } chunks.push(chunk) })
    stream.on("error", reject)
    stream.on("end", () => total === entry.uncompressedSize ? resolve(new Uint8Array(Buffer.concat(chunks, total))) : reject(new AppError(422, "archive_size_mismatch", `${entry.fileName} did not match its declared size.`)))
  }))
}

export async function extractConfirmedArchiveFiles(archives: Array<{ filename: string; bytes: Uint8Array }>, confirmations: Array<{ archiveName: string; path: string; rowId: string; category: ArchiveCategory }>): Promise<Array<{ archiveName: string; path: string; rowId: string; category: ArchiveCategory; filename: string; bytes: Uint8Array }>> {
  const confirmationMap = new Map(confirmations.map((item) => [`${item.archiveName}\u0000${item.path}`, item]))
  if (confirmationMap.size !== confirmations.length) throw new AppError(422, "archive_confirmation_duplicate", "Each archive file can be associated only once.")
  const output: Array<{ archiveName: string; path: string; rowId: string; category: ArchiveCategory; filename: string; bytes: Uint8Array }> = []; let total = 0
  for (const archive of archives) await walkZip(archive, async (entry, zip) => {
    if (isDirectory(entry)) return
    const confirmation = confirmationMap.get(`${archive.filename}\u0000${entry.fileName}`); if (!confirmation) return
    validateEntry(entry, archive.filename); total += entry.uncompressedSize
    if (total > MAX_EXPANDED_BYTES) throw new AppError(422, "archive_expansion_limit", "Confirmed files exceed the 250 MiB safety limit.")
    output.push({ ...confirmation, filename: basename(entry.fileName), bytes: await readEntryBounded(zip, entry) })
  })
  if (output.length !== confirmations.length) throw new AppError(409, "archive_changed", "The selected archives changed after preview. Review document matches again.")
  return output
}
