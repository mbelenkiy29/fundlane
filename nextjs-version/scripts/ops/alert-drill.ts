import { pathToFileURL } from "node:url"
import { Client, type QueryResult } from "pg"

import {
  runMonitor,
  type MonitorConfig,
  type MonitorDb,
} from "../../src/lib/mca/operations/monitor"

const PRODUCTION_PROJECT_REF = "drubsfvhlggmtyiigwxy"
const DRILL_ORIGIN = "https://offline.invalid"
const DRILL_WEBHOOK = "https://webhook.offline.invalid/transactional"
const DRILL_RECIPIENT = "operator@offline.invalid"

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<QueryResult>
}

export type AlertDrillAttempt = {
  kind: "opening" | "recovery"
  state: "accepted" | "unknown" | "rejected"
  id: string
}

export type AlertDrillEvidence = {
  schemaVersion: 1
  drillKind: "offline_transactional_alert"
  component: "website"
  attempts: AlertDrillAttempt[]
  requestCount: number
  rollbackStatus: "rolled_back"
  elapsedMs: number
}

export function assertAlertDrillGuards(input: {
  env: Readonly<Record<string, string | undefined>>
  argv: readonly string[]
}): string {
  if (input.env.MCA_OPS_ALERT_DRILL_ENABLED !== "true")
    throw new Error(
      "Set MCA_OPS_ALERT_DRILL_ENABLED=true to run the local alert drill."
    )
  if (!input.argv.includes("--confirm"))
    throw new Error(
      "Pass --confirm to acknowledge that the drill will use a disposable local database."
    )
  const value = input.env.MCA_OPS_ALERT_DRILL_DATABASE_URL
  if (!value)
    throw new Error(
      "MCA_OPS_ALERT_DRILL_DATABASE_URL must point to an already migrated disposable loopback PostgreSQL database."
    )
  if (value.toLowerCase().includes(PRODUCTION_PROJECT_REF))
    throw new Error(
      "Refusing to run the alert drill against the production Supabase project."
    )
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(
      "MCA_OPS_ALERT_DRILL_DATABASE_URL must point to an already migrated disposable loopback PostgreSQL database."
    )
  }
  if (
    url.protocol !== "postgresql:" &&
    url.protocol !== "postgres:"
  )
    throw new Error(
      "MCA_OPS_ALERT_DRILL_DATABASE_URL must point to an already migrated disposable loopback PostgreSQL database."
    )
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error(
      "The alert drill accepts only localhost, 127.0.0.1, or ::1."
    )
  return value
}

export function sanitizeAlertDrillEvidence(input: {
  attempts: Array<Record<string, unknown>>
  requestCount: unknown
  elapsedMs: unknown
}): AlertDrillEvidence {
  const safeId = (value: unknown) => {
    const id = String(value).toLowerCase()
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
      ? id
      : "invalid"
  }
  return {
    schemaVersion: 1,
    drillKind: "offline_transactional_alert",
    component: "website",
    attempts: input.attempts.map((attempt) => ({
      kind: attempt.kind === "recovery" ? "recovery" : "opening",
      state:
        attempt.state === "unknown" || attempt.state === "rejected"
          ? attempt.state
          : "accepted",
      id: safeId(attempt.id),
    })),
    requestCount: Number(input.requestCount),
    rollbackStatus: "rolled_back",
    elapsedMs: Math.max(0, Math.round(Number(input.elapsedMs))),
  }
}

function syntheticHealthResponse(websiteOk: boolean): Response {
  if (websiteOk)
    return Response.json({
      databaseOk: true,
      databaseMs: 1,
      deployment: "offline_drill",
    })

  // The monitor reads `ok` once for the website and once for the database.
  // This test-only response isolates a failed website while keeping its DB check healthy.
  let reads = 0
  return {
    status: 503,
    get ok() {
      reads += 1
      return reads > 1
    },
    json: async () => ({
      databaseOk: true,
      databaseMs: 1,
      deployment: "offline_drill",
    }),
  } as Response
}

export async function runAlertDrill(
  client: Queryable,
  fetcher?: typeof fetch
): Promise<AlertDrillEvidence> {
  const started = performance.now()
  const captured: Array<{ url: string; init?: RequestInit }> = []
  let healthChecks = 0
  const offlineFetcher: typeof fetch = async (url) => {
    if (String(url) === `${DRILL_ORIGIN}/api/internal/health`) {
      const response = syntheticHealthResponse(healthChecks >= 3)
      healthChecks += 1
      return response
    }
    return new Response(null, { status: 202 })
  }
  const delegate = fetcher ?? offlineFetcher
  const selectedFetcher: typeof fetch = async (url, init) => {
    if (String(url) === DRILL_WEBHOOK)
      captured.push({ url: String(url), init })
    return delegate(url, init)
  }
  let evidence: AlertDrillEvidence | undefined
  await client.query("BEGIN")
  try {
    const relations = await client.query(
      `SELECT to_regclass('mca_private.ops_control')::text AS control,
        to_regclass('mca_private.ops_incidents')::text AS incidents,
        to_regclass('mca_private.ops_alert_attempts')::text AS attempts`
    )
    const schema = relations.rows[0] as
      | { control?: string | null; incidents?: string | null; attempts?: string | null }
      | undefined
    if (!schema?.control || !schema.incidents || !schema.attempts)
      throw new Error(
        "The alert drill database is missing the operations schema. Apply the checked migrations to the disposable database first."
      )

    await client.query(
      "UPDATE mca_private.ops_control SET document_worker_heartbeat_at=now()"
    )
    const db: MonitorDb = {
      query: async (sql, values) =>
        (await client.query(sql, values)).rows as Record<string, unknown>[],
    }
    const config: MonitorConfig = {
      origin: DRILL_ORIGIN,
      token: "offline-drill-token",
      alerts: true,
      recipient: DRILL_RECIPIENT,
      webhook: DRILL_WEBHOOK,
      webhookToken: "offline-drill-webhook-token",
      recoveryAlerts: false,
    }
    for (let observation = 0; observation < 6; observation += 1) {
      await client.query(
        "UPDATE mca_private.ops_control SET last_started_at=NULL"
      )
      await runMonitor(db, config, selectedFetcher)
    }

    const result = await client.query(
      `SELECT id::text,kind,state FROM mca_private.ops_alert_attempts
       WHERE component='website'
       ORDER BY CASE kind WHEN 'opening' THEN 0 WHEN 'recovery' THEN 1 ELSE 2 END,id`
    )
    const attempts = result.rows as Array<Record<string, unknown>>
    const unfinished = await client.query(
      "SELECT id FROM mca_private.ops_alert_attempts WHERE state IN ('pending','sending')"
    )
    const kinds = attempts.map((attempt) => attempt.kind)
    const states = attempts.map((attempt) => attempt.state)
    const validStates =
      states.every((state) => state === "accepted") ||
      (states[0] === "unknown" && states[1] === "accepted")
    if (
      attempts.length !== 2 ||
      kinds[0] !== "opening" ||
      kinds[1] !== "recovery" ||
      !validStates ||
      unfinished.rowCount !== 0
    )
      throw new Error(
        "The mocked alert drill did not produce one accepted opening and one accepted recovery attempt."
      )

    const requests = captured
    if (
      requests.length !== 2 ||
      requests.some((request, index) => {
          const body = JSON.parse(String(request.init?.body)) as {
            template?: string
          }
          const id = String(attempts[index]?.id)
          const headers = new Headers(request.init?.headers)
          return (
            request.url !== DRILL_WEBHOOK ||
            body.template !== "operations_alert" ||
            headers.get("idempotency-key") !== id ||
            headers.get("x-correlation-id") !== id
          )
        })
    )
      throw new Error(
        "The mocked alert drill did not produce one accepted opening and one accepted recovery attempt."
      )
    evidence = sanitizeAlertDrillEvidence({
      attempts,
      requestCount: requests.length,
      elapsedMs: performance.now() - started,
    })
  } finally {
    await client.query("ROLLBACK")
  }
  return evidence!
}

type Connector = (databaseUrl: string) => Promise<{
  client: Queryable
  close: () => Promise<void>
}>

async function connect(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  return { client, close: () => client.end() }
}

export async function main(
  argv = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  connector: Connector = connect
): Promise<void> {
  const databaseUrl = assertAlertDrillGuards({ env, argv })
  const connection = await connector(databaseUrl)
  try {
    const evidence = await runAlertDrill(connection.client)
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
  } finally {
    await connection.close()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch(() => {
    process.stderr.write("Local alert drill failed.\n")
    process.exitCode = 1
  })
