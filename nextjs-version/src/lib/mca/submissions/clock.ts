import { nowIso as systemNowIso } from "../db"

let override: (() => string) | null = null

export function nowIso(): string {
  return override ? override() : systemNowIso()
}

export function setClock(next: (() => string) | null): void {
  override = next
}
