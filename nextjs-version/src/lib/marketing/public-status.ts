import "server-only"
import { unstable_cache } from "next/cache"
import { withTransaction } from "@/lib/mca/db"

export type PublicStatusCheck = { databaseAvailable: boolean; checkedAt: string }

export const getPublicStatusCheck = unstable_cache(async (): Promise<PublicStatusCheck> => {
  let databaseAvailable = false
  try {
    await withTransaction(async (db) => {
      await db.query("SET LOCAL statement_timeout='2000ms'")
      await db.query("SELECT 1")
    })
    databaseAvailable = true
  } catch {
    // The public page exposes only a coarse state, including on probe failures.
  }
  return { databaseAvailable, checkedAt: new Date().toISOString() }
}, ["public-status-check"], { revalidate: 60 })
