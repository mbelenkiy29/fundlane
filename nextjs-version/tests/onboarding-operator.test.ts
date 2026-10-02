import test, { before, after, beforeEach, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { authDatabase, liveIdentity, provider, resetAuthProvider } from "./helpers/onboarding-auth"
import { getDatabase, newId, nowIso } from "../src/lib/mca/db"
import { linkSupabaseUser } from "../src/lib/mca/supabase-auth"
import { requireSuperAdmin, type SuperAdminActor } from "../src/lib/mca/platform-auth"
import { createEnrollment, recordEnrollmentActivation } from "../src/lib/mca/onboarding/store"
import { withTransaction } from "../src/lib/mca/db"
import { BILLING_CATALOG } from "../src/lib/mca/billing-catalog"
import type { EnrollmentOffer } from "../src/lib/mca/onboarding/contracts"
import { resumeSecret, enrollmentTestEnv } from "./helpers/onboarding-billing"

const instant = "2030-01-01T12:00:00.000Z"
const offer: EnrollmentOffer = { version: 1, accountId: "acct_fixture", basePriceId: "price_base", seatPriceId: "price_seats", currency: "usd", baseAmount: BILLING_CATALOG.base.unitAmountCents, quantity: 1, trialDays: 14, livemode: false, promotionCodes: false, automaticTax: false }
let close: () => Promise<void>, actor: SuperAdminActor
let ownerIdentity: Awaited<ReturnType<typeof liveIdentity>>
let operator: typeof import("../src/lib/mca/onboarding/operator") | undefined
let route: typeof import("../src/app/api/platform/onboarding/route") | undefined
before(async () => {
  close = await authDatabase("onboarding_operator")
  ownerIdentity = await liveIdentity("mike@sentineltechsolutions.io")
  const userId = await linkSupabaseUser(ownerIdentity)
  await getDatabase().execute("INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES (?,?,'test','Synthetic queue acceptance')", [userId, nowIso()])
  actor = await requireSuperAdmin()
  operator = await import("../src/lib/mca/onboarding/operator").catch(() => undefined)
  route = await import("../src/app/api/platform/onboarding/route").catch(() => undefined)
})
after(async () => { await close?.() })
beforeEach(async t => {
  (t as TestContext).mock.timers.enable({ apis: ["Date"], now: Date.parse(instant) })
  resetAuthProvider()
  provider.current = ownerIdentity
  Object.assign(process.env, enrollmentTestEnv)
  delete process.env.MCA_ONBOARDING_EMAIL_ENABLED
  await getDatabase().execute("TRUNCATE mca_enrollments CASCADE")
  await getDatabase().execute("UPDATE platform_admin_grants SET revoked_at=NULL WHERE user_id=?", [actor.userId])
})
const request = (query = "", headers?: HeadersInit) => new Request(`http://localhost:3000/api/platform/onboarding${query}`, { headers })
async function enrollment() { return createEnrollment({ resumeSecret: resumeSecret(), offer }) }

test("sanitized diagnostic queue remains readable with runtime off and never reads providers or changes history", async t => {
  assert.ok(operator && route)
  const row = await enrollment()
  await withTransaction(db => recordEnrollmentActivation(row.id, { sessionId: `cs_${row.id}`, customerId: `cus_${row.id}`, subscriptionId: `sub_${row.id}`, email: "SECRET-CONTACT@example.test", businessName: "PRIVATE-BUSINESS", trialStartedAt: instant, trialEndsAt: "2030-01-15T12:00:00.000Z", verifiedAt: instant, billingStatus: "trialing", livemode: false }, db))
  await getDatabase().execute("UPDATE mca_enrollments SET next_reconcile_at=?,error_code='secret_provider_error',revision=revision+1 WHERE id=?", ["2030-01-01T11:40:00.000Z", row.id])
  await getDatabase().execute("UPDATE mca_onboarding_service_emails SET state='uncertain',error_code='secret_mail_error' WHERE enrollment_id=? AND purpose='getting_started'", [row.id])
  const before = await getDatabase().queryOne("SELECT revision,updated_at FROM mca_enrollments WHERE id=?", [row.id])
  t.mock.method(globalThis, "fetch", async () => { throw new Error("GET must not fetch providers") })
  process.env.MCA_ONBOARDING_RUNTIME_ENABLED = "false"
  const response = await route.GET(request())
  assert.equal(response.status, 200)
  assert.match(response.headers.get("cache-control")!, /private, no-store/)
  const page = await response.json()
  assert.deepEqual(page.runtime, { enabled: false, creationEnabled: false, emailEnabled: false })
  assert.equal(page.snapshotAt, instant)
  assert.equal(page.items[0].repairState, "stalled")
  assert.equal(page.items[0].hasRepairError, true)
  assert.deepEqual(page.items[0].emails.map((mail: { purpose: string; state: string; hasError: boolean }) => [mail.purpose, mail.state, mail.hasError]), [["business_information_requested", "queued", false], ["getting_started", "uncertain", true]])
  assert.doesNotMatch(JSON.stringify(page), /SECRET|PRIVATE-BUSINESS|secret_|cipher|hash|providerMessage|email@|emailDomain|resumeSecret|purchaseEvidence|EIN/)
  assert.deepEqual(Object.keys(page.items[0]).sort(), ["enrollmentId", "revision", "createdAt", "updatedAt", "workspaceId", "checkoutState", "billingState", "claimState", "finalizationState", "recoveryState", "trialEndsAt", "activatedAt", "verifiedAt", "nextReconcileAt", "leaseUntil", "repairState", "hasRepairError", "emails"].sort())
  assert.deepEqual(await getDatabase().queryOne("SELECT revision,updated_at FROM mca_enrollments WHERE id=?", [row.id]), before)
})

test("101 timestamp-tied enrollments page without loss and filters precede the bounded limit", async () => {
  assert.ok(operator)
  const rows = await Promise.all(Array.from({ length: 101 }, enrollment))
  const selected = rows.at(-1)!
  await getDatabase().execute("UPDATE mca_enrollments SET recovery_state='operator_required',revision=revision+1 WHERE id=?", [selected.id])
  const ids: string[] = []; let cursor: string | undefined
  do {
    const page = await operator.listEnrollmentOperations(actor, { limit: 50, cursor })
    assert.ok(page.items.length <= 50)
    ids.push(...page.items.map(item => item.enrollmentId)); cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert.equal(ids.length, 101); assert.equal(new Set(ids).size, 101)
  assert.deepEqual((await operator.listEnrollmentOperations(actor, { limit: 1, state: "operator_required" })).items.map(item => item.enrollmentId), [selected.id])
  assert.deepEqual((await operator.listEnrollmentOperations(actor, { limit: 1, enrollmentId: selected.id })).items.map(item => item.enrollmentId), [selected.id])
  const first = await operator.listEnrollmentOperations(actor, { limit: 1 })
  await assert.rejects(operator.listEnrollmentOperations(actor, { limit: 1, state: "operator_required", cursor: first.nextCursor! }), { code: "invalid_query" })
  await assert.rejects(operator.listEnrollmentOperations(actor, { limit: 1, enrollmentId: selected.id, cursor: first.nextCursor! }), { code: "invalid_query" })
})

test("repair facts distinguish future work, due work, stalled work and an active lease at the exact boundary", async () => {
  assert.ok(operator)
  const [future, due, stalled, leased] = await Promise.all(Array.from({ length: 4 }, enrollment))
  for (const [id, next] of [[future.id, "2030-01-01T12:01:00.000Z"], [due.id, instant], [stalled.id, "2030-01-01T11:45:00.000Z"], [leased.id, "2030-01-01T11:00:00.000Z"]]) await getDatabase().execute("UPDATE mca_enrollments SET next_reconcile_at=?,revision=revision+1 WHERE id=?", [next, id])
  await getDatabase().execute("UPDATE mca_enrollments SET claim_token=?,lease_until=?,revision=revision+1 WHERE id=?", [newId(), "2030-01-01T12:05:00.000Z", leased.id])
  const page = await operator.listEnrollmentOperations(actor, { limit: 50 })
  assert.deepEqual(Object.fromEntries(page.items.map(row => [row.enrollmentId, row.repairState])), { [future.id]: "scheduled", [due.id]: "due", [stalled.id]: "stalled", [leased.id]: "lease_active" })
  assert.deepEqual(new Set((await operator.listEnrollmentOperations(actor, { limit: 50, state: "due" })).items.map(row => row.enrollmentId)), new Set([due.id, stalled.id]))
  assert.deepEqual((await operator.listEnrollmentOperations(actor, { limit: 50, state: "stalled" })).items.map(row => row.enrollmentId), [stalled.id])
})

test("HTTP validates bounded locators/cursors and rechecks real grants and same-session authority", async () => {
  assert.ok(operator && route)
  await enrollment()
  for (const query of ["?limit=0", "?limit=101", "?cursor=garbage", "?enrollmentId=foreign", "?state=unknown", "?secret=private"]) assert.equal((await route.GET(request(query))).status, 422, query)
  assert.equal((await route.GET(request("", { authorization: "Bearer mca_fake" }))).status, 403)
  await assert.rejects(operator.listEnrollmentOperations({ ...actor, sessionId: newId() }, { limit: 50 }), { code: "super_admin_required" })
  await getDatabase().execute("UPDATE platform_admin_grants SET revoked_at=? WHERE user_id=?", [instant, actor.userId])
  assert.equal((await route.GET(request())).status, 403)
  await assert.rejects(operator.listEnrollmentOperations(actor, { limit: 50 }), { status: 403 })
  provider.current = null
  assert.equal((await route.GET(request())).status, 401)
})

test("operator queue renders disabled, empty, loading and stale snapshots without treating accepted mail as received", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const React=require('react'); const {renderToStaticMarkup}=require('react-dom/server');
    const {EnrollmentQueueResults}=require('./src/components/mca/platform/onboarding-queue.tsx');
    const row={enrollmentId:'opaque-id',revision:1,createdAt:'2030-01-01',updatedAt:'2030-01-01',workspaceId:null,checkoutState:'complete',billingState:'trialing',claimState:'unclaimed',finalizationState:'pending',recoveryState:'none',trialEndsAt:'2030-01-15',activatedAt:'2030-01-01',verifiedAt:'2030-01-01',nextReconcileAt:'2030-01-01',leaseUntil:null,repairState:'stalled',hasRepairError:true,emails:[{purpose:'business_information_requested',state:'accepted',attempts:1,hasError:false,nextAttemptAt:'2030-01-01'},{purpose:'getting_started',state:'uncertain',attempts:1,hasError:true,nextAttemptAt:'2030-01-01'}]};
    const page={items:[row],nextCursor:null,snapshotAt:'2030-01-01T12:00:00Z',runtime:{enabled:false,creationEnabled:false,emailEnabled:false}};
    console.log(JSON.stringify([{loading:true},{page:{...page,items:[]}},{error:'Access denied.'},{page,error:'Refresh failed.'}].map(props=>renderToStaticMarkup(React.createElement(EnrollmentQueueResults,props)))));
  `], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  const [loading, empty, denied, stale] = JSON.parse(result.stdout) as string[]
  assert.match(loading, /role="status"/); assert.match(empty, /No matching enrollments/)
  assert.match(denied, /role="alert"/); assert.match(stale, /Stale snapshot/)
  assert.match(stale, /Runtime disabled/); assert.match(stale, /Creation disabled/); assert.match(stale, /Mail disabled/)
  assert.match(stale, /accepted/); assert.match(stale, /uncertain/); assert.match(stale, /Accepted is not proof of receipt/)
  assert.match(stale, /tabindex="0"/); assert.match(stale, /overflow-auto/)
  assert.doesNotMatch(stale, /mailto:|approve|reissue|type="submit"|href="\/platform\/onboarding\//)
})
