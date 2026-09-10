import "server-only"

import { mkdir, open, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export interface DocumentStorage {
  readonly name: string
  putImmutable(key: string, bytes: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array>
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
  return storageOverride ?? new FilesystemDocumentStorage()
}
