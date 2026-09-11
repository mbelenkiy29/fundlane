import "server-only"
import { createHash } from "node:crypto"
import { mkdir, open, readFile, rm, statfs } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fromBuffer } from "yauzl"
import * as XLSX from "xlsx"
import { getDatabase, newId, nowIso, withTransaction } from "../db"
import { encryptSensitive, decryptSensitive } from "../crypto"
import { AppError } from "../errors"
import { documentScanner } from "../documents/scanner"
import type { DealActor } from "../deals/schema"
import {
  ownedConversation,
  assertRunning,
  seal,
  unseal,
  trackDeal,
  type Conversation
} from "./repository"
import { assertProvenance } from "./experience"
import { FILE_RETENTION_MS, type AssistantFile } from "./experience-contracts"
export const MAX_FILE_BYTES = 25 * 1024 * 1024,
  MAX_STORAGE_BYTES = 500 * 1024 * 1024
export const fileTypes: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg"
}
export interface FileRecord {
  id: string
  conversation_id: string
  workspace_id: string
  user_id: string
  run_id: string | null
  name_cipher: string
  mime: string
  byte_length: number
  checksum: string
  storage_key: string
  state: AssistantFile["state"]
  parent_id: string | null
  provenance_cipher: string
  expires_at: string
}
function location(key: string) {
  if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes(".."))
    throw new Error("Invalid assistant storage key")
  const root = resolve(
    process.env.MCA_DOCUMENT_STORAGE_PATH ?? "data/documents",
    "assistant"
  )
  const path = resolve(root, key)
  if (!path.startsWith(root + "/"))
    throw new Error("Invalid assistant storage path")
  return path
}
export async function removeStoredFile(key: string) {
  await rm(location(key), { force: true })
}
function filename(name: string) {
  return name.replace(/[\x00-\x1f/\\]/g, "_").slice(-180) || "file.txt"
}
export async function officeEntries(bytes: Buffer) {
  return new Promise<Map<string, Buffer>>((resolvePromise, reject) => {
    fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(
            new AppError(
              422,
              "invalid_office_file",
              "The Office file could not be read."
            )
          )
          return
        }
        const entries = new Map<string, Buffer>()
        let count = 0,
          total = 0,
          done = false
        const fail = () => {
          if (done) return
          done = true
          zip.close()
          reject(
            new AppError(
              422,
              "unsafe_office_file",
              "This file contains unsupported active content or an unsafe archive."
            )
          )
        }
        zip.on("error", fail)
        zip.on("entry", (entry) => {
          count++
          total += entry.uncompressedSize
          if (
            count > 3000 ||
            total > 75 * 1024 * 1024 ||
            entry.uncompressedSize > 25 * 1024 * 1024 ||
            entry.fileName.includes("..") ||
            /vbaProject|externalLinks|connections\.xml|embeddings\/|activeX/i.test(
              entry.fileName
            ) ||
            entry.generalPurposeBitFlag & 1
          ) {
            fail()
            return
          }
          if (!/\.(xml|rels)$/.test(entry.fileName)) {
            zip.readEntry()
            return
          }
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) {
              fail()
              return
            }
            const chunks: Buffer[] = []
            let size = 0
            stream.on("data", (b: Buffer) => {
              size += b.length
              if (size > 25 * 1024 * 1024) {
                stream.destroy()
                fail()
              } else chunks.push(b)
            })
            stream.on("error", fail)
            stream.on("end", () => {
              if (done) return
              const data = Buffer.concat(chunks)
              const text = data.toString("utf8")
              if (
                /<!DOCTYPE|<!ENTITY|TargetMode=["']External["']|WEBSERVICE\s*\(|DDE\s*\(/i.test(
                  text
                )
              ) {
                fail()
                return
              }
              entries.set(entry.fileName, data)
              zip.readEntry()
            })
          })
        })
        zip.on("end", () => {
          if (!done) {
            done = true
            resolvePromise(entries)
          }
        })
        zip.readEntry()
      }
    )
  })
}
export async function validateFile(name: string, bytes: Buffer) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "",
    mime = fileTypes[ext]
  if (!mime || !bytes.length || bytes.length > MAX_FILE_BYTES)
    throw new AppError(
      422,
      "file_invalid",
      "Use a supported document or image up to 25 MB."
    )
  const start = bytes.subarray(0, 8)
  if (
    (ext === "pdf" && !start.toString().startsWith("%PDF-")) ||
    (ext === "png" &&
      !start.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (["jpg", "jpeg"].includes(ext) && !(start[0] === 255 && start[1] === 216))
  )
    throw new AppError(
      422,
      "file_type_mismatch",
      "The file content does not match its name."
    )
  if (["docx", "xlsx", "pptx"].includes(ext)) {
    const entries = await officeEntries(bytes)
    if (
      !entries.has("[Content_Types].xml") ||
      ![...entries.keys()].some((k) =>
        k.startsWith(ext === "docx" ? "word/" : ext === "xlsx" ? "xl/" : "ppt/")
      )
    )
      throw new AppError(
        422,
        "file_type_mismatch",
        "The Office file content does not match its name."
      )
  }
  if (["txt", "md", "csv"].includes(ext) && bytes.includes(0))
    throw new AppError(
      422,
      "file_type_mismatch",
      "Text files must contain plain UTF-8 text."
    )
  return mime
}
export async function scanFile(name: string, bytes: Buffer) {
  const scan = await documentScanner().scan(bytes, name)
  if (scan.status !== "clean")
    throw new AppError(
      scan.status === "infected" ? 422 : 503,
      "file_scan_failed",
      scan.status === "infected"
        ? "This file did not pass its safety scan."
        : "File scanning is unavailable. Please try again after your administrator restores scanning."
    )
}
export function fileView(f: FileRecord): AssistantFile {
  return {
    id: f.id,
    name: unseal<string>(f.workspace_id, f.name_cipher),
    mime: f.mime,
    bytes: f.byte_length,
    expiresAt: f.expires_at,
    state: f.state === "ready" && f.expires_at < nowIso() ? "expired" : f.state,
    parentId: f.parent_id,
    runId: f.run_id
  }
}
export async function listFiles(c: Conversation) {
  const rows = await getDatabase()
    .prepare<FileRecord>(
      "SELECT * FROM mca_assistant_files WHERE conversation_id=? AND workspace_id=? AND user_id=? ORDER BY created_at DESC LIMIT 200"
    )
    .all(c.id, c.workspace_id, c.user_id)
  return rows.map(fileView)
}
export async function getFile(
  actor: DealActor,
  id: string,
  allowExpired = false
) {
  const row = await getDatabase()
    .prepare<FileRecord>(
      "SELECT * FROM mca_assistant_files WHERE id=? AND workspace_id=? AND user_id=?"
    )
    .get(id, actor.workspaceId, actor.userId)
  if (!row)
    throw new AppError(404, "file_unavailable", "This file is unavailable.")
  await ownedConversation(actor, row.conversation_id)
  await assertProvenance(
    actor,
    unseal<string[]>(actor.workspaceId, row.provenance_cipher)
  )
  if (!allowExpired && (row.state !== "ready" || row.expires_at < nowIso()))
    throw new AppError(
      410,
      "file_expired",
      "This file is expired or unavailable. Upload a fresh copy to continue."
    )
  return row
}
export async function fileBytes(actor: DealActor, id: string) {
  const record = await getFile(actor, id)
  const bytes = Buffer.from(
    decryptSensitive(
      await readFile(location(record.storage_key), "utf8"),
      actor.workspaceId
    ),
    "base64"
  )
  if (createHash("sha256").update(bytes).digest("hex") !== record.checksum)
    throw new AppError(
      409,
      "file_corrupt",
      "This file failed its integrity check."
    )
  return { record, bytes }
}
export async function validateAttachments(
  actor: DealActor,
  c: Conversation,
  ids: string[]
) {
  if (new Set(ids).size !== ids.length || ids.length > 5)
    throw new AppError(422, "file_limit", "Choose up to five different files.")
  let total = 0
  for (const id of ids) {
    const f = await getFile(actor, id)
    total += f.byte_length
    for (const dealId of unseal<string[]>(
      actor.workspaceId,
      f.provenance_cipher
    ))
      await trackDeal(c, dealId)
  }
  if (total > 50 * 1024 * 1024)
    throw new AppError(
      413,
      "file_limit",
      "The combined file size must be at most 50 MB."
    )
}
export async function storeFile(
  actor: DealActor,
  c: Conversation,
  name: string,
  bytes: Buffer,
  runId?: string,
  parentId?: string
) {
  const safeName = filename(name),
    mime = await validateFile(safeName, bytes)
  await scanFile(safeName, bytes)
  const id = newId(),
    key = `${actor.workspaceId}/${actor.userId}/${id}`,
    expires = new Date(Date.now() + FILE_RETENTION_MS).toISOString()
  await ownedConversation(actor, c.id)
  if (parentId) await getFile(actor, parentId)
  const refs = await getDatabase()
    .prepare<{
      deal_id: string
    }>("SELECT deal_id FROM mca_assistant_references WHERE conversation_id=?")
    .all(c.id)
  const provenance = [
    ...new Set(
      [c.deal_id, ...refs.map((r) => r.deal_id)].filter((v): v is string =>
        Boolean(v)
      )
    )
  ]
  await assertProvenance(actor, provenance)
  await mkdir(dirname(location(key)), { recursive: true, mode: 0o700 })
  const disk = await statfs(dirname(location(key)))
  if (disk.bavail * disk.bsize < bytes.length * 2 + 100 * 1024 * 1024)
    throw new AppError(
      503,
      "file_storage_full",
      "File storage is temporarily full."
    )
  await withTransaction(async (db) => {
    // Serialize quota reservations by membership, including simultaneous uploads.
    const member = await db
      .prepare(
        "SELECT id FROM memberships WHERE workspace_id=? AND user_id=? AND status='active' FOR UPDATE"
      )
      .get(actor.workspaceId, actor.userId)
    if (!member)
      throw new AppError(
        403,
        "membership_inactive",
        "Your company membership is no longer active."
      )
    const used = await db
      .prepare<{
        bytes: string
      }>("SELECT COALESCE(SUM(byte_length),0) AS bytes FROM mca_assistant_files WHERE workspace_id=? AND user_id=? AND state IN ('ready','processing') AND expires_at>?")
      .get(actor.workspaceId, actor.userId, nowIso())
    if (Number(used?.bytes) + bytes.length > MAX_STORAGE_BYTES)
      throw new AppError(
        413,
        "storage_limit",
        "Your 500 MB file allowance is full. Delete older files before uploading more."
      )
    if (runId) {
      await assertRunning(runId)
      const count = await db
        .prepare<{
          count: string
        }>("SELECT COUNT(*) AS count FROM mca_assistant_files WHERE run_id=?")
        .get(runId)
      if (Number(count?.count) >= 10)
        throw new AppError(
          409,
          "output_limit",
          "This request reached its ten-file output limit."
        )
    }
    await db
      .prepare(
        "INSERT INTO mca_assistant_files(id,conversation_id,run_id,workspace_id,user_id,name_cipher,mime,byte_length,checksum,storage_key,state,parent_id,provenance_cipher,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,'processing',?,?,?,?)"
      )
      .run(
        id,
        c.id,
        runId ?? null,
        actor.workspaceId,
        actor.userId,
        seal(actor.workspaceId, safeName),
        mime,
        bytes.length,
        createHash("sha256").update(bytes).digest("hex"),
        key,
        parentId ?? null,
        seal(actor.workspaceId, provenance),
        nowIso(),
        expires
      )
  })
  try {
    const handle = await open(location(key), "wx", 0o600)
    try {
      await handle.writeFile(
        encryptSensitive(bytes.toString("base64"), actor.workspaceId)
      )
    } finally {
      await handle.close()
    }
    await ownedConversation(actor, c.id)
    if (runId) await assertRunning(runId)
    await getDatabase()
      .prepare("UPDATE mca_assistant_files SET state='ready' WHERE id=?")
      .run(id)
  } catch (error) {
    await getDatabase()
      .prepare(
        "UPDATE mca_assistant_files SET state='failed',expires_at=? WHERE id=?"
      )
      .run(nowIso(), id)
    await removeStoredFile(key)
    throw error
  }
  return fileView(await getFile(actor, id))
}
export async function deleteFile(actor: DealActor, id: string) {
  const f = await getFile(actor, id, true)
  await getDatabase()
    .prepare(
      "UPDATE mca_assistant_files SET state='deleted',expires_at=? WHERE id=?"
    )
    .run(nowIso(), id)
  await removeStoredFile(f.storage_key)
}
export async function previewFile(actor: DealActor, id: string) {
  const { record, bytes } = await fileBytes(actor, id),
    name = unseal<string>(actor.workspaceId, record.name_cipher),
    ext = name.split(".").pop()?.toLowerCase()
  if (ext === "xlsx" || ext === "csv") {
    const workbook = XLSX.read(bytes, {
      type: "buffer",
      sheetRows: 101,
      cellFormula: false,
      bookVBA: false
    })
    return {
      kind: "tables",
      sheets: workbook.SheetNames.slice(0, 5).map((n) => ({
        name: n,
        rows: XLSX.utils
          .sheet_to_json(workbook.Sheets[n], { header: 1, defval: "" })
          .slice(0, 101)
      }))
    }
  }
  if (ext === "docx" || ext === "pptx") {
    const entries = await officeEntries(bytes)
    const text = [...entries.entries()]
      .filter(([key]) =>
        ext === "docx"
          ? key === "word/document.xml"
          : /^ppt\/slides\/slide\d+\.xml$/.test(key)
      )
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([, data]) =>
        data
          .toString()
          .replace(/<\/(?:w:p|a:p)>/g, "\n")
          .replace(/<[^>]*>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
      )
      .join("\n\n")
      .slice(0, 20000)
    return { kind: "text", text }
  }
  if (record.mime.startsWith("text/"))
    return { kind: "text", text: bytes.toString("utf8").slice(0, 20000) }
  return { kind: record.mime === "application/pdf" ? "pdf" : "image" }
}
