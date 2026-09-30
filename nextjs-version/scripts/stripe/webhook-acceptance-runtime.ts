import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile, rm, writeFile } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { reserveLoopbackPort } from "../../tests/helpers/loopback-port.mjs"

/** Run the actual route in Next's request scope, including its after() lifecycle. */
export async function startAcceptanceNextServer(env: NodeJS.ProcessEnv, onOutput: (chunk: Buffer) => void = () => {}) {
  const reservation = await reserveLoopbackPort()
  const dist = `.next-acceptance-webhook-${randomUUID()}`
  await reservation.release()
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(reservation.port)], {
    env: { ...env, NEXT_DIST_DIR: dist, MCA_APP_ORIGIN: `http://127.0.0.1:${reservation.port}` }, stdio: ["ignore", "pipe", "pipe"],
  })
  let spawnError = false
  child.on("error", () => { spawnError = true })
  child.stdout.on("data", onOutput)
  child.stderr.on("data", onOutput)
  const close = async () => {
    if (!spawnError && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
      child.kill("SIGTERM")
      await Promise.race([exited, sleep(5000)])
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited }
    }
    await rm(dist, { recursive: true, force: true })
    // Next dev adds its generated types to tsconfig; remove only this run's paths.
    const config = JSON.parse(await readFile("tsconfig.json", "utf8"))
    if (Array.isArray(config.include)) {
      const owned = new Set([`${dist}/types/**/*.ts`, `${dist}/dev/types/**/*.ts`])
      const include = config.include.filter((path: string) => !owned.has(path))
      if (include.length !== config.include.length) {
        config.include = include
        await writeFile("tsconfig.json", `${JSON.stringify(config, null, 2)}\n`)
      }
    }
  }
  const endpoint = `http://127.0.0.1:${reservation.port}/api/webhooks/stripe`
  try {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error("Acceptance Next server exited; private output suppressed")
      try {
        if ((await fetch(endpoint, { signal: AbortSignal.timeout(5000) })).status === 405) return { endpoint, close }
      } catch { /* Wait for the loopback listener and route compilation. */ }
      await sleep(200)
    }
    throw new Error("Acceptance Next server did not become ready; private output suppressed")
  } catch (error) { await close(); throw error }
}

export async function forwardAcceptanceWebhook(endpoint: string, body: string, signature: string) {
  return fetch(endpoint, { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body, signal: AbortSignal.timeout(15000) })
}

type Query = (sql: string, parameters: string[]) => Promise<{ rows: Array<Record<string, unknown>> }>
/** An HTTP receipt is not completion: require its exact durable receipt and completed job. */
export async function waitForAcceptanceReconciliation(query: Query, result: Record<string, unknown>, eventId: string, workspaceId: string, customerId: string, timeoutMs = 30000) {
  assert.equal(result.queued, true)
  assert.equal(result.workspaceId, workspaceId)
  assert.equal(typeof result.jobId, "string")
  const receipt = await query("SELECT event_id,workspace_id,stripe_customer_id FROM stripe_billing_events WHERE event_id=$1", [eventId])
  assert.deepEqual(receipt.rows, [{ event_id: eventId, workspace_id: workspaceId, stripe_customer_id: customerId }])
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { rows } = await query("SELECT state FROM mca_background_jobs WHERE id=$1 AND workspace_id=$2 AND kind='billing_reconcile' AND resource_id=$3", [result.jobId as string, workspaceId, eventId])
    if (rows[0]?.state === "complete") return
    if (rows[0]?.state === "failed" || rows[0]?.state === "canceled") throw new Error("Acceptance reconciliation job did not complete")
    if (Date.now() >= deadline) throw new Error("Acceptance receipt persisted but reconciliation did not complete before deadline")
    await sleep(100)
  }
}
