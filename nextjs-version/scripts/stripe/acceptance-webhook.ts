#!/usr/bin/env -S node --conditions=react-server --import tsx
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import Stripe from "stripe"

const ACCOUNT = "acct_1UIDeIBP3qJwlwms"
class AcceptanceError extends Error {}
type Delivery = { body: string; signature: string; event: string; status: number; result: Record<string, unknown> }

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Run with Node 24 --conditions=react-server --import tsx; requires --apply --evidence=/private/new.json, STRIPE_SECRET_KEY, MCA_STRIPE_MODE=test, and loopback MCA_TEST_DATABASE_ADMIN_URL port 55439. Creates and cleans only tagged synthetic resources. CLI output is private and deleted.")
    return
  }
  const evidencePath = process.argv.find(v => v.startsWith("--evidence="))?.slice(11)
  if (!process.argv.includes("--apply") || !evidencePath) throw new AcceptanceError("Require --apply and --evidence path")
  const key = process.env.STRIPE_SECRET_KEY
  if (!key || !/^(sk|rk)_test_/.test(key) || process.env.MCA_STRIPE_MODE !== "test") throw new AcceptanceError("Explicit sandbox key and test mode required")
  const admin = new URL(process.env.MCA_TEST_DATABASE_ADMIN_URL ?? "invalid:")
  if (!['postgres:', 'postgresql:'].includes(admin.protocol) || admin.hostname !== "127.0.0.1" || admin.port !== "55439" || admin.search) throw new AcceptanceError("Disposable loopback database on port 55439 required")
  const stripe = new Stripe(key, { apiVersion: "2026-08-26.dahlia", timeout: 15000, maxNetworkRetries: 1 })
  assert.equal((await stripe.accounts.retrieve(null)).id, ACCOUNT)
  const run = `fundlane-webhook-${randomUUID()}`
  const evidence = { account: ACCOUNT, run, startedAt: new Date().toISOString(), result: "running", stage: "listener", checks: [] as string[], ids: {} as Record<string, string>, cleanup: [] as string[] }
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: "wx", mode: 0o600 })
  const save = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 })
  const check = async (name: string) => { evidence.checks.push(name); await save(); console.log(name) }
  const privateDir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "fundlane-webhook-"))
  const log = await open(join(privateDir, "listener.log"), "wx", 0o600)
  let listener: ChildProcess | undefined
  let database: Awaited<ReturnType<typeof import("../../tests/helpers/postgres-test-db.mjs").createPostgresTestDatabase>> | undefined
  let closeApp: (() => Promise<void>) | undefined
  let route: ((request: Request) => Promise<Response>) | undefined
  let customerId: string | undefined
  const deliveries: Delivery[] = []
  const held: Array<{ body: string; signature: string; event: Stripe.Event }> = []
  let hold = false
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/api/webhooks/stripe" || !route) { response.writeHead(404).end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString("utf8")
      const signature = String(request.headers["stripe-signature"] ?? "")
      const incoming = JSON.parse(body) as Stripe.Event
      if (hold && (incoming.data.object as { customer?: string }).customer === customerId) {
        held.push({ body, signature, event: incoming })
        response.writeHead(200, { "content-type": "application/json" }).end('{"held":true}')
        return
      }
      const result = await route(new Request("http://127.0.0.1/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signature }, body }))
      const text = await result.text()
      const event = JSON.parse(body) as Stripe.Event
      const object = event.data.object as { customer?: string }
      if (object.customer === customerId) deliveries.push({ body, signature, event: event.id, status: result.status, result: JSON.parse(text) })
      response.writeHead(result.status, { "content-type": "application/json" }).end(text)
    } catch { response.writeHead(500).end() }
  })
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const endpoint = `http://127.0.0.1:${address.port}/api/webhooks/stripe`
    listener = spawn("stripe", ["listen", "--latest", "--events", "customer.subscription.updated,customer.subscription.deleted", "--forward-to", endpoint], { env: { ...process.env, STRIPE_API_KEY: key }, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    let listenerError = false
    listener.on("error", () => { listenerError = true })
    for (const stream of [listener.stdout, listener.stderr]) stream!.on("data", (chunk: Buffer) => { output += chunk.toString(); void log.write(chunk) })
    for (let i = 0; i < 100 && !/whsec_[A-Za-z0-9]+/.test(output); i++) {
      if (listenerError || listener.exitCode !== null) break
      await sleep(200)
    }
    const secret = output.match(/whsec_[A-Za-z0-9]+/)?.[0]
    if (!secret) throw new AcceptanceError(/permission|403|unauthorized/i.test(output) ? "Stripe CLI listen permission denied (private log suppressed)" : "Stripe CLI listener unavailable (private log suppressed)")
    process.env.STRIPE_BILLING_WEBHOOK_SECRET = secret
    await check("sandbox account and real CLI signing secret verified")
    evidence.stage = "database and catalog"
    const { createPostgresTestDatabase } = await import("../../tests/helpers/postgres-test-db.mjs")
    database = await createPostgresTestDatabase("stripe_webhook")
    evidence.ids.database = database.databaseName
    Object.assign(process.env, { DATABASE_URL: database.databaseUrl, DATABASE_URL_UNPOOLED: database.databaseUrlUnpooled, MCA_STRIPE_BILLING_ENABLED: "true" })
    const { getDatabase, closeDatabaseForTests, nowIso } = await import("../../src/lib/mca/db")
    closeApp = closeDatabaseForTests
    const { createWorkspaceWithAdmin } = await import("../../src/lib/mca/workspaces")
    const metadata = { acceptance_run: run, application: "fundlane" }
    const product = await stripe.products.create({ name: run, metadata }, { idempotencyKey: `${run}-product` })
    evidence.ids.product = product.id; await save()
    const base = await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: 39900, recurring: { interval: "month" }, metadata }, { idempotencyKey: `${run}-base` })
    evidence.ids.base = base.id; await save()
    const seats = await stripe.prices.create({ product: product.id, currency: "usd", billing_scheme: "tiered", tiers_mode: "graduated", recurring: { interval: "month" }, tiers: [{ up_to: 9, unit_amount: 7900 }, { up_to: 19, unit_amount: 6900 }, { up_to: "inf", unit_amount: 5900 }], metadata }, { idempotencyKey: `${run}-seats` })
    evidence.ids.seats = seats.id; await save()
    process.env.STRIPE_BASE_PRICE_ID = base.id
    process.env.STRIPE_ADDITIONAL_SEAT_PRICE_ID = seats.id
    const local = await createWorkspaceWithAdmin({ workspaceName: run, adminName: "Synthetic webhook owner", adminEmail: `${run}@example.test`, password: `${randomUUID()}aA9!`, role: "admin" })
    const other = await createWorkspaceWithAdmin({ workspaceName: `${run}-control`, adminName: "Synthetic control", adminEmail: `${run}-control@example.test`, password: `${randomUUID()}aA9!`, role: "admin" })
    evidence.ids.workspace = local.workspaceId
    const customer = await stripe.customers.create({ name: run, metadata: { ...metadata, workspace_id: local.workspaceId } }, { idempotencyKey: `${run}-customer` })
    customerId = customer.id; evidence.ids.customer = customer.id; await save()
    assert.equal(customer.livemode, false)
    await getDatabase().prepare("INSERT INTO workspace_stripe_customers (workspace_id,stripe_customer_id,livemode,created_at) VALUES (?,?,0,?)").run(local.workspaceId, customer.id, nowIso())
    const paymentMethod = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id })
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: paymentMethod.id } })
    const subscription = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: base.id, quantity: 1 }], payment_behavior: "error_if_incomplete", metadata: { ...metadata, workspace_id: local.workspaceId } }, { idempotencyKey: `${run}-subscription` })
    evidence.ids.subscription = subscription.id; await save()
    assert.equal(subscription.status, "active")
    const db = getDatabase()
    const snapshot = async () => ({ entitlements: await db.prepare("SELECT * FROM workspace_billing_entitlements ORDER BY workspace_id").all(), receipts: await db.prepare("SELECT * FROM stripe_billing_events ORDER BY event_id").all(), audits: await db.prepare("SELECT * FROM audit_events ORDER BY id").all() })
    const before = await snapshot()
    assert.equal(before.entitlements.length, 0)
    route = (await import("../../src/app/api/webhooks/stripe/route")).POST
    assert.equal((await fetch(`${endpoint}?success=true&session_id=untrusted`)).status, 404)
    assert.deepEqual(await snapshot(), before)
    await check("paid provider state and untrusted success URL do not independently grant local entitlements")
    evidence.stage = "real HTTP delivery"
    await stripe.subscriptions.update(subscription.id, { metadata: { acceptance_delivery: run } })
    for (let i = 0; i < 150 && !deliveries.some(d => d.result.reconciled); i++) await sleep(200)
    const delivery = deliveries.find(d => d.result.reconciled)
    if (!delivery) throw new AcceptanceError(`No reconciled CLI delivery; observed HTTP statuses: ${deliveries.map(d => d.status).join(",") || "none"}`)
    assert.equal(delivery.status, 200)
    evidence.ids.event = delivery.event
    const actual = await stripe.events.retrieve(delivery.event)
    assert.equal(actual.type, "customer.subscription.updated")
    assert.equal(actual.livemode, false)
    const rows = await database.query("SELECT event_id,workspace_id,stripe_customer_id FROM stripe_billing_events WHERE event_id=$1", [delivery.event])
    assert.deepEqual(rows.rows, [{ event_id: delivery.event, workspace_id: local.workspaceId, stripe_customer_id: customer.id }])
    const entitlement = await db.prepare<{status: string; seat_limit: number}>("SELECT status,seat_limit FROM workspace_billing_entitlements WHERE workspace_id=?").get(local.workspaceId)
    assert.equal(entitlement?.status, "active")
    assert.equal(entitlement.seat_limit, 1)
    assert.equal(await db.prepare("SELECT workspace_id FROM workspace_billing_entitlements WHERE workspace_id=?").get(other.workspaceId), undefined)
    await check("genuine Stripe CLI forwarded event: actual POST route HTTP 200, independently visible durable company-scoped receipt and paid entitlement; control company unchanged")
    const committed = await snapshot()
    const duplicate = await fetch(endpoint, { method: "POST", headers: { "stripe-signature": delivery.signature }, body: delivery.body })
    assert.equal(duplicate.status, 200)
    assert.equal((await duplicate.json()).duplicate, true)
    assert.deepEqual(await snapshot(), committed)
    await check("exact forwarded HTTP request replay: 200 duplicate=true; receipts, entitlements and audits unchanged")
    const tampered = await fetch(endpoint, { method: "POST", headers: { "stripe-signature": delivery.signature }, body: `${delivery.body} ` })
    assert.equal(tampered.status, 400)
    assert.deepEqual(await snapshot(), committed)
    await check("tampered raw payload with genuine original signature: HTTP 400; database unchanged")
    evidence.stage = "out-of-order genuine signed delivery"
    hold = true
    await stripe.subscriptions.update(subscription.id, { metadata: { acceptance_order: "older-active" } })
    for (let i = 0; i < 150 && !held.some(d => d.event.type === "customer.subscription.updated"); i++) await sleep(200)
    const older = held.find(d => d.event.type === "customer.subscription.updated")
    assert.ok(older)
    assert.equal((older.event.data.object as Stripe.Subscription).status, "active")
    await stripe.subscriptions.cancel(subscription.id)
    for (let i = 0; i < 150 && !held.some(d => d.event.type === "customer.subscription.deleted"); i++) await sleep(200)
    const newer = held.find(d => d.event.type === "customer.subscription.deleted")
    assert.ok(newer)
    hold = false
    const { getCompanyAccess } = await import("../../src/lib/mca/company-access")
    for (const item of [newer, older]) {
      const response = await fetch(endpoint, { method: "POST", headers: { "stripe-signature": item.signature }, body: item.body })
      assert.equal(response.status, 200)
      assert.equal((await response.json()).reconciled, true)
      assert.equal((await getCompanyAccess(local.workspaceId)).allowed, false)
      assert.equal((await db.prepare<{status: string}>("SELECT status FROM workspace_billing_entitlements WHERE workspace_id=?").get(local.workspaceId))?.status, "canceled")
    }
    evidence.ids.olderEvent = older.event.id
    evidence.ids.newerEvent = newer.event.id
    const outOfOrderReceipts = await database.query("SELECT count(*)::int AS count FROM stripe_billing_events WHERE event_id=ANY($1::text[]) AND workspace_id=$2", [[older.event.id, newer.event.id], local.workspaceId])
    assert.equal(outOfOrderReceipts.rows[0].count, 2)
    assert.equal(await db.prepare("SELECT workspace_id FROM workspace_billing_entitlements WHERE workspace_id=?").get(other.workspaceId), undefined)
    await check("genuine signed cancellation delivered before older active event: both HTTP 200 and durable receipts; fresh provider reads keep canceled company blocked and control unchanged")
    evidence.result = "passed"
  } catch (error) {
    evidence.result = "blocked-or-failed"
    if (error instanceof AcceptanceError) console.error(error.message)
    else if (error instanceof Stripe.errors.StripeError) console.error(`Stripe failure: ${error.type} ${error.code ?? ""} HTTP ${error.statusCode ?? "unknown"}`)
    else console.error(`Acceptance failed at ${evidence.stage}: ${error instanceof Error ? error.name : "unknown"}`)
    process.exitCode = 1
  } finally {
    if (listener && listener.exitCode === null) {
      const exited = new Promise<void>(resolve => listener!.once("exit", () => resolve()))
      listener.kill("SIGTERM")
      await Promise.race([exited, sleep(5000)])
      if (listener.exitCode === null) { listener.kill("SIGKILL"); await exited }
    }
    evidence.cleanup.push("listener stopped")
    await new Promise<void>(resolve => server.close(() => resolve()))
    const cleanup = async (name: string, fn: () => Promise<unknown>) => { try { await fn(); evidence.cleanup.push(name) } catch { evidence.cleanup.push(`${name}: FAILED`); process.exitCode = 1 } }
    await cleanup("owned subscription canceled", async () => {
      if (!evidence.ids.subscription) return
      const sub = await stripe.subscriptions.retrieve(evidence.ids.subscription)
      assert.equal(sub.metadata.acceptance_run, run); assert.equal(sub.livemode, false)
      if (sub.status !== "canceled") await stripe.subscriptions.cancel(sub.id)
    })
    await cleanup("owned customer deleted", async () => {
      if (!customerId) return
      const customer = await stripe.customers.retrieve(customerId)
      if (!customer.deleted) { assert.equal(customer.metadata.acceptance_run, run); assert.equal(customer.livemode, false); await stripe.customers.del(customerId) }
    })
    await cleanup("owned catalog archived", async () => {
      if (!evidence.ids.product) return
      const product = await stripe.products.retrieve(evidence.ids.product)
      assert.equal(product.metadata.acceptance_run, run); assert.equal(product.livemode, false)
      for await (const price of stripe.prices.list({ product: product.id, limit: 100 })) await stripe.prices.update(price.id, { active: false })
      await stripe.products.update(product.id, { active: false })
    })
    await cleanup("disposable database dropped", async () => { await closeApp?.(); await database?.close() })
    await log.close()
    await rm(privateDir, { recursive: true, force: true })
    delete process.env.STRIPE_BILLING_WEBHOOK_SECRET
    evidence.cleanup.push("private listener output deleted")
    await save()
    console.log(JSON.stringify({ result: evidence.result, stage: evidence.stage, cleanup: evidence.cleanup }))
  }
}
main().catch(error => { console.error(error instanceof AcceptanceError ? error.message : "Webhook acceptance preflight failed; secret-bearing error suppressed"); process.exitCode = 1 })
