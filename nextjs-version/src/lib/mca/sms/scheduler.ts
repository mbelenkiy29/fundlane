import "server-only"

import { Client } from "pg"
import { postgresConnection } from "../db-connection"
import { assertHostedSupabaseConfig } from "../hosted-config"
import { getDatabase } from "../db"
import { outsideExecutionScope } from "../jobs/execution"
import { maintenance } from "./maintenance"
import { platformReady } from "./onboarding"
import { twilioApi, type TwilioApi } from "./provisioning"

const LOCK_KEY = "mca:sms:scheduled"

export async function runScheduledSmsJobs(api: TwilioApi = twilioApi) {
  const ready = platformReady() && Boolean(process.env.MCA_TWILIO_PARENT_ACCOUNT_SID && process.env.MCA_TWILIO_PARENT_AUTH_TOKEN)
  const idle = { operations: 0, companies: 0, failedWorkspaces: [] as string[], operationStates: {} as Record<string, number> }
  if (!ready) return { ready: false, running: false, ...idle }

  assertHostedSupabaseConfig()
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required.")
  // Hold a transaction-scoped lock on one dedicated connection. Transaction
  // pooling cannot safely retain a session advisory lock between statements.
  const client = new Client({ ...postgresConnection(url), connectionTimeoutMillis: 10_000 })
  let transactionOpen = false
  try {
    await client.connect()
    await client.query("BEGIN")
    transactionOpen = true
    const locked = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired", [LOCK_KEY])
    if (!locked.rows[0]?.acquired) return { ready: true, running: true, ...idle }
    const result = await maintenance(api, { operations: 1, companies: 2 })
    const states = await getDatabase().prepare<{ state: string; count: number }>(
      "SELECT state,count(*)::int AS count FROM sms_operations GROUP BY state"
    ).all()
    return {
      ready: true,
      running: false,
      ...result,
      operationStates: Object.fromEntries(states.map(({ state, count }) => [state, count])),
    }
  } finally {
    await outsideExecutionScope(async () => {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined)
      await client.end().catch(() => undefined)
    })
  }
}
