import "server-only"

import { mkdir, open, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { assertHostedSupabaseConfig } from "../hosted-config"
import { AppError } from "../errors"

export interface DocumentStorage {
  readonly name: string
  putImmutable(key: string, bytes: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array>
  signedDownload?(key: string, filename?: string): Promise<string>
  promoteClean?(key: string, bytes: Uint8Array): Promise<void>
}

export function validateStorageKey(key: string): string {
  if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("Invalid storage key")
  return key
}

export function storageClient(): SupabaseClient {
  assertHostedSupabaseConfig()
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new AppError(503, "storage_unavailable", "Document storage is not configured.")
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
}

export class SupabaseDocumentStorage implements DocumentStorage {
  readonly name = "supabase"
  constructor(
    readonly bucket = process.env.MCA_SUPABASE_DOCUMENT_BUCKET ?? "fundlane-documents",
    private readonly client = storageClient(),
  ) {}

  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    const { error } = await this.client.storage.from(quarantineBucket()).upload(validateStorageKey(key), bytes, { upsert: false, contentType: "application/octet-stream" })
    if (error) throw new AppError(503, "storage_write_failed", "Document storage could not save this file.")
  }

  async get(key: string): Promise<Uint8Array> {
    for (const bucket of [this.bucket, quarantineBucket()]) {
      const { data, error } = await this.client.storage.from(bucket).download(validateStorageKey(key))
      if (data && !error) return new Uint8Array(await data.arrayBuffer())
      if (error && !["404", "400"].includes(String((error as { statusCode?: string }).statusCode))) throw new AppError(503, "storage_read_failed", "Document storage could not read this file.")
    }
    throw Object.assign(new Error("Document object not found"), { code: "ENOENT" })
  }

  async promoteClean(key: string, bytes: Uint8Array): Promise<void> {
    const contentType = Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-" ? "application/pdf" : bytes[0] === 137 ? "image/png" : bytes[0] === 255 ? "image/jpeg" : "application/octet-stream"
    const { error } = await this.client.storage.from(this.bucket).upload(validateStorageKey(key), bytes, { upsert: false, contentType })
    if (error) {
      const existing = await this.client.storage.from(this.bucket).download(key)
      if (existing.error || !existing.data || !Buffer.from(await existing.data.arrayBuffer()).equals(Buffer.from(bytes))) throw new AppError(409, "immutable_storage_conflict", "The destination contains different bytes.")
    }
    // Internal quarantine keys have no browser upload capability; clean copies are immutable.
    await this.client.storage.from(quarantineBucket()).remove([key])
  }

  async signedDownload(key: string, filename?: string): Promise<string> {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrl(validateStorageKey(key), 60, { download: filename ?? false })
    if (error || !data) throw new AppError(503, "storage_download_failed", "Document storage could not issue a download link.")
    return data.signedUrl
  }
}

export function quarantineBucket(): string { return process.env.MCA_SUPABASE_QUARANTINE_BUCKET ?? "fundlane-quarantine" }

export function usesSupabaseStorage(): boolean {
  return process.env.MCA_DOCUMENT_STORAGE_PROVIDER === "supabase"
}

export class FilesystemDocumentStorage implements DocumentStorage {
  readonly name = "filesystem"
  constructor(private readonly root = resolve(process.env.MCA_DOCUMENT_STORAGE_PATH ?? "data/documents")) {}

  private pathFor(key: string): string {
    if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes("..")) throw new Error("Invalid storage key")
    const path = resolve(this.root, key)
    if (path !== this.root && !path.startsWith(`${this.root}/`)) throw new Error("Invalid storage key")
    return path
  }

  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const handle = await open(path, "wx", 0o600)
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(key)))
  }
}

let storageOverride: DocumentStorage | undefined

export function setDocumentStorageForTests(storage?: DocumentStorage): void {
  storageOverride = storage
}

export function documentStorage(): DocumentStorage {
  if (storageOverride) return storageOverride
  if (usesSupabaseStorage()) return new SupabaseDocumentStorage()
  if (process.env.VERCEL) throw new AppError(503, "storage_unavailable", "Configure Supabase document storage before serving uploads on Vercel.")
  return new FilesystemDocumentStorage()
}
