import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomBytes, createHash, createHmac } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import {
  getDatabase,
  closeDatabaseForTests,
  nowIso,
  withImmediateTransaction,
} from "../src/lib/mca/db"
import {
  encryptSensitive,
  hashOpaqueToken,
  createOpaqueToken,
} from "../src/lib/mca/crypto"
import {
  signUp,
  verifyEmail,
  reviewCompany,
  saveProvider,
  profileSchema,
  publicOrigin,
  type ProviderConfig,
  type Company,
} from "../src/lib/mca/sms/onboarding"
import {
  requestProvisioning,
  runProvisioning,
  reserveUsage,
  assignNumber,
  type TwilioApi,
} from "../src/lib/mca/sms/provisioning"
import { reconcileOperation } from "../src/lib/mca/sms/maintenance"
import { persistInbound, listConversations } from "../src/lib/mca/sms/inbox"
import {
  assertNotSuppressed,
  managedReady,
  reserveManagedSend,
  suppress,
  smsRecipientHash,
} from "../src/lib/mca/sms/managed"
import { twilioMessageForm } from "../src/lib/mca/sms/adapters/twilio/mapping"
import { registrationEvents } from "../src/lib/mca/sms/registration-events"
import { listSmsAccounts } from "../src/lib/mca/sms/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { AuthContext } from "../src/lib/mca/types"
let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>,
  owner: { workspaceId: string; userId: string; membershipId: string },
  actor: DealActor,
  context: AuthContext
const env = { ...process.env },
  p: ProviderConfig = {
    accountSid: `AC${"a".repeat(32)}`,
    authToken: "synthetic-auth",
    apiKeySid: `SK${"b".repeat(32)}`,
    apiKeySecret: "synthetic-key",
    serviceSid: `MG${"c".repeat(32)}`,
    brandSid: `BN${"c".repeat(32)}`,
    campaignSid: `QE${"d".repeat(32)}`,
  }
const profile = {
  businessType: "Limited Liability Corporation",
  contactPosition: "CEO",
  contactTitle: "Chief executive",
  legalName: "Synthetic Business",
  ein: "12-3456789",
  street: "100 Test Road",
  city: "New York",
  region: "NY",
  postalCode: "10001",
  website: "https://example.test",
  contactFirstName: "Test",
  contactLastName: "Owner",
  contactEmail: "owner@example.test",
  contactPhone: "+12125551234",
  purpose:
    "Requested application status updates only, never unsolicited loan offers.",
  samples: [
    "Your requested application is ready for review.",
    "Please provide documents for your requested application.",
  ],
  consentEvidence:
    "Customers explicitly request application text updates on our first-party form.",
  privacyUrl: "https://example.test/privacy",
  termsUrl: "https://example.test/terms",
  applicationUpdatesOnly: true,
}
before(async () => {
  fixture = await createPostgresTestDatabase("sms_onboarding")
  Object.assign(
    process.env,
    fixture.env({
      MCA_DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
      MCA_APP_ORIGIN: "https://crm.example.test",
      MCA_SMS_ISV_APPROVED: "true",
      MCA_SMS_ELIGIBILITY_REFERENCE: "synthetic-approval",
      MCA_TWILIO_PRIMARY_PROFILE_SID: `BU${"e".repeat(32)}`,
      MCA_SMS_REGISTRATION_ESTIMATE_CENTS: "100",
      MCA_SMS_SEGMENT_ESTIMATE_CENTS: "5",
    })
  )
  owner = await signUp({
    companyName: "Synthetic SMS",
    name: "Owner",
    email: "newowner@example.test",
    password: "SyntheticPassword123",
    terms: true,
  })
  actor = {
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    membershipId: owner.membershipId,
    role: "admin",
    source: "user",
    managedMembershipIds: [],
    activeMembershipIds: [owner.membershipId],
    correlationId: "test-onboarding",
  }
  context = {
    authType: "session",
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    membershipId: owner.membershipId,
    role: "super_admin",
    scopes: [],
    sessionId: "synthetic-session",
  }
})
after(async () => {
  await closeDatabaseForTests()
  await fixture?.close()
  for (const key of Object.keys(process.env))
    if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
})
test("signup creates an admin and prevents unauthenticated reuse of an existing email", async () => {
  const m = await getDatabase()
    .prepare<{ role: string }>("SELECT role FROM memberships WHERE id=?")
    .get(owner.membershipId)
  assert.equal(m?.role, "admin")
  await assert.rejects(
    signUp({
      companyName: "Attacker company",
      name: "Attacker",
      email: "newowner@example.test",
      password: "NotTheRealPassword12",
      terms: true,
    }),
    { code: "sign_in_required" }
  )
})
test("public SMS origin trims values, falls back only when blank, and rejects invalid origins", () => {
  const sms = process.env.MCA_SMS_PUBLIC_BASE_URL, app = process.env.MCA_APP_ORIGIN
  try {
    for (const value of ["", "   "]) {
      process.env.MCA_SMS_PUBLIC_BASE_URL = value
      process.env.MCA_APP_ORIGIN = " https://fallback.example.test "
      assert.equal(publicOrigin(), "https://fallback.example.test")
    }
    process.env.MCA_SMS_PUBLIC_BASE_URL = " https://sms.example.test "
    assert.equal(publicOrigin(), "https://sms.example.test")
    for (const value of ["http://sms.example.test", "https://sms.example.test/path", "not a URL"]) {
      process.env.MCA_SMS_PUBLIC_BASE_URL = value
      process.env.MCA_APP_ORIGIN = "https://fallback.example.test"
      assert.throws(() => publicOrigin(), { code: "sms_public_url_unconfigured", status: 503 })
    }
    process.env.MCA_SMS_PUBLIC_BASE_URL = ""
    process.env.MCA_APP_ORIGIN = "http://fallback.example.test"
    assert.throws(() => publicOrigin(), { code: "sms_public_url_unconfigured", status: 503 })
    delete process.env.MCA_SMS_PUBLIC_BASE_URL
    delete process.env.MCA_APP_ORIGIN
    assert.throws(() => publicOrigin(), { code: "sms_public_url_unconfigured", status: 503 })
  } finally {
    if (sms === undefined) delete process.env.MCA_SMS_PUBLIC_BASE_URL
    else process.env.MCA_SMS_PUBLIC_BASE_URL = sms
    if (app === undefined) delete process.env.MCA_APP_ORIGIN
    else process.env.MCA_APP_ORIGIN = app
  }
})

test("parallel suppressions serialize on the recipient lock and leave one row", async () => {
  const recipient = "+12125559876", hash = smsRecipientHash(owner.workspaceId, recipient)
  let acquired!: () => void, release!: () => void
  const locked = new Promise<void>((resolve) => { acquired = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const holder = withImmediateTransaction(async (db) => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`sms-consent:${hash}`)
    acquired()
    await held
  })
  await locked
  let completed = false
  const first = suppress(owner.workspaceId, recipient, "opted_out").then(() => { completed = true })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(completed, false, "suppress must wait for the held advisory lock")
  } finally {
    release()
    await holder
    await first
  }
  await Promise.all([
    suppress(owner.workspaceId, recipient, "opted_in"),
    suppress(owner.workspaceId, recipient, "opted_in"),
  ])
  const rows = await getDatabase().prepare<{ state: string }>("SELECT state FROM sms_suppressions WHERE workspace_id=? AND recipient_hash=?").all(owner.workspaceId, hash)
  assert.deepEqual(rows, [{ state: "opted_in" }])
})
test("email verification is expiring and single-use", async () => {
  const token = createOpaqueToken(),
    expired = createOpaqueToken()
  await getDatabase()
    .prepare(
      "INSERT INTO sms_email_tokens (token_hash,workspace_id,user_id,expires_at,created_at) VALUES (?,?,?,?,?),(?,?,?,?,?)"
    )
    .run(
      hashOpaqueToken(token),
      owner.workspaceId,
      owner.userId,
      "2099-01-01T00:00:00.000Z",
      nowIso(),
      hashOpaqueToken(expired),
      owner.workspaceId,
      owner.userId,
      "2000-01-01T00:00:00.000Z",
      nowIso()
    )
  await assert.rejects(verifyEmail(expired), { code: "verification_invalid" })
  assert.equal((await verifyEmail(token)).verified, true)
  await assert.rejects(verifyEmail(token), { code: "verification_invalid" })
})
test("workspace super_admin cannot approve companies; explicit platform operators can", async () => {
  await getDatabase()
    .prepare("UPDATE sms_companies SET profile_cipher=? WHERE workspace_id=?")
    .run(
      encryptSensitive(
        JSON.stringify(profileSchema.parse(profile)),
        owner.workspaceId
      ),
      owner.workspaceId
    )
  const input = {
    workspaceId: owner.workspaceId,
    decision: "approved" as const,
    note: "Synthetic evidence verified",
    numberLimit: 3,
    monthlyLimitCents: 500,
    registrationLimitCents: 100,
  }
  await assert.rejects(reviewCompany(context, input), {
    code: "platform_operator_required",
  })
  process.env.MCA_PLATFORM_OPERATOR_USER_IDS = owner.userId
  await reviewCompany(context, input)
})
test("registration requires platform readiness and stable retries do not create another operation", async () => {
  process.env.MCA_SMS_ISV_APPROVED = "false"
  await assert.rejects(
    requestProvisioning(actor, {
      kind: "register",
      idempotencyKey: "register-v1",
    }),
    { code: "sms_onboarding_required" }
  )
  process.env.MCA_SMS_ISV_APPROVED = "true"
  const one = await requestProvisioning(actor, {
      kind: "register",
      idempotencyKey: "register-v1",
    }),
    two = await requestProvisioning(actor, {
      kind: "register",
      idempotencyKey: "register-v1",
    })
  assert.equal(one.id, two.id)
  await getDatabase()
    .prepare("UPDATE sms_operations SET state='failed' WHERE id=?")
    .run(one.id)
})
test("concurrent reservations never exceed a company allowance", async () => {
  const reserve = (id: string) =>
    withImmediateTransaction(async (db) => {
      const c = await db
        .prepare<Company>(
          "SELECT * FROM sms_companies WHERE workspace_id=? FOR UPDATE"
        )
        .get(owner.workspaceId)
      await reserveUsage(db, c!, id, "sms_outbound", 300)
    })
  const results = await Promise.allSettled([
    reserve("race-a"),
    reserve("race-b"),
  ])
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1)
  assert.equal(results.filter((x) => x.status === "rejected").length, 1)
  await getDatabase()
    .prepare("DELETE FROM sms_usage WHERE workspace_id=?")
    .run(owner.workspaceId)
})
test("signed inbound processing suppresses a recipient before any deal exists and deduplicates replies", async () => {
  const phone = "+12125551111",
    to = "+12125552222",
    sid = `SM${"1".repeat(32)}`
  const params = new URLSearchParams({
    From: phone,
    To: to,
    MessageSid: sid,
    Body: "STOP",
    OptOutType: "STOP",
  })
  await persistInbound(
    owner.workspaceId,
    "synthetic-route",
    params,
    "phone_number",
    to
  )
  await persistInbound(
    owner.workspaceId,
    "synthetic-route",
    params,
    "phone_number",
    to
  )
  await assert.rejects(
    withImmediateTransaction((db) =>
      assertNotSuppressed(db, owner.workspaceId, phone)
    ),
    { code: "sms_recipient_opted_out" }
  )
  const count = await getDatabase()
    .prepare<{
      n: number
    }>("SELECT count(*)::int n FROM sms_inbox_messages WHERE workspace_id=?")
    .get(owner.workspaceId)
  assert.equal(count?.n, 1)
  const admin = await listConversations(actor)
  assert.equal(admin.conversations.length, 1)
  assert.equal(admin.conversations[0].dealId, null)
  assert.equal(
    (await listConversations({ ...actor, role: "rep" })).conversations.length,
    0
  )
  await assert.rejects(
    persistInbound(
      owner.workspaceId,
      "synthetic-route",
      params,
      "phone_number",
      "+12125553333"
    ),
    { code: "twilio_sender_mismatch" }
  )
})
test("number purchase recovers a lost provider response without buying a second number", async () => {
  await saveProvider(owner.workspaceId, p)
  await getDatabase()
    .prepare(
      "UPDATE sms_companies SET registration_state='approved',opt_out_ready=1 WHERE workspace_id=?"
    )
    .run(owner.workspaceId)
  const op = await requestProvisioning(actor, {
    kind: "purchase",
    idempotencyKey: "buy-v1",
    phone: "+12125554444",
    membershipId: owner.membershipId,
    maxMonthlyCents: 115,
  })
  let purchases = 0
  const pn = `PN${"f".repeat(32)}`
  const api: TwilioApi = async (_p, host, path, method) => {
    if (host === "pricing")
      return {
        price_unit: "USD",
        phone_number_prices: [{ number_type: "local", current_price: "1.15" }],
      }
    if (path.includes("IncomingPhoneNumbers.json") && method === "POST") {
      purchases++
      throw new Error("timeout after purchase")
    }
    if (path.includes("IncomingPhoneNumbers.json"))
      return {
        incoming_phone_numbers: [
          {
            sid: pn,
            friendly_name: `Fundlane ${op.id}`,
            phone_number: "+12125554444",
          },
        ],
      }
    if (path.includes("/PhoneNumbers")) return { sid: pn }
    throw new Error(`Unexpected request ${host} ${path}`)
  }
  await runProvisioning(op.id, api)
  await runProvisioning(op.id, api)
  assert.equal(purchases, 1)
  assert.equal(
    (
      await getDatabase()
        .prepare<{
          state: string
        }>("SELECT state FROM sms_operations WHERE id=?")
        .get(op.id)
    )?.state,
    "needs_review"
  )
  await reconcileOperation(context, op.id, api)
  await runProvisioning(op.id, api)
  assert.equal(purchases, 1)
  assert.equal(
    (
      await getDatabase()
        .prepare<{
          state: string
        }>("SELECT state FROM sms_operations WHERE id=?")
        .get(op.id)
    )?.state,
    "complete"
  )
  assert.equal(await managedReady(owner.workspaceId, op.id), false)
})
test("expired worker lease quarantines an uncertain paid purchase without calling Twilio", async () => {
  const id = "synthetic-expired-purchase"
  const now = nowIso()
  await getDatabase().prepare("INSERT INTO sms_operations (id,workspace_id,kind,request_key,payload_cipher,state,step,lease_until,created_at,updated_at) VALUES (?,?,'purchase',?,?,'running','purchase',?,?,?)")
    .run(id, owner.workspaceId, id, encryptSensitive(JSON.stringify({ kind: "purchase", phone: "+12125559999" }), owner.workspaceId), "2000-01-01T00:00:00.000Z", now, now)
  let providerCalls = 0
  await runProvisioning(id, async () => { providerCalls++; throw new Error("unexpected provider call") })
  const state = await getDatabase().prepare<{ state: string; error_code: string }>("SELECT state,error_code FROM sms_operations WHERE id=?").get(id)
  assert.deepEqual(state, { state: "needs_review", error_code: "provider_outcome_unknown" })
  assert.equal(providerCalls, 0)
})
test("registration callbacks reject forged signatures and preserve the newest status", async () => {
  const n = await getDatabase()
    .prepare<{
      id: string
      provider_sid: string
    }>("SELECT id,provider_sid FROM sms_numbers WHERE workspace_id=?")
    .get(owner.workspaceId)
  assert.ok(n)
  const make = (id: string, time: string, status: string, valid = true) => {
    const raw = JSON.stringify([
      {
        id,
        type: `com.twilio.messaging.compliance.number-registration.${status === "registered" ? "successful" : "pending"}`,
        time,
        data: {
          accountsid: p.accountSid,
          messagingservicesid: p.serviceSid,
          phonenumbersid: n.provider_sid,
          externalstatus: status,
        },
      },
    ])
    const hash = createHash("sha256").update(raw).digest("hex"),
      url = `https://crm.example.test/api/mca/sms/webhooks/registration/${owner.workspaceId}?bodySHA256=${hash}`,
      signature = createHmac("sha1", p.authToken).update(url).digest("base64")
    return new Request(url, {
      method: "POST",
      headers: { "x-twilio-signature": valid ? signature : "invalid" },
      body: raw,
    })
  }
  await assert.rejects(
    registrationEvents(
      owner.workspaceId,
      make("bad", "2026-09-09T12:00:00.000Z", "registered", false)
    ),
    { code: "twilio_signature_invalid" }
  )
  await registrationEvents(
    owner.workspaceId,
    make("new", "2026-09-09T12:00:00.000Z", "registered")
  )
  await registrationEvents(
    owner.workspaceId,
    make("old", "2026-09-08T12:00:00.000Z", "pending_registration")
  )
  assert.equal(await managedReady(owner.workspaceId, n.id), true)
  await getDatabase()
    .prepare("UPDATE sms_companies SET suspended=1 WHERE workspace_id=?")
    .run(owner.workspaceId)
  assert.equal(await managedReady(owner.workspaceId, n.id), false)
  await getDatabase()
    .prepare("UPDATE sms_companies SET suspended=0 WHERE workspace_id=?")
    .run(owner.workspaceId)
})
test("managed sender readiness requires eligibility, campaign approval and send credentials", async () => {
  const n = await getDatabase().prepare<{ id: string }>("SELECT id FROM sms_numbers WHERE workspace_id=?").get(owner.workspaceId)
  assert.ok(n)
  const eligibility = process.env.MCA_SMS_ELIGIBILITY_REFERENCE
  const cronEnabled = process.env.MCA_SMS_CRON_ENABLED
  try {
    process.env.MCA_SMS_CRON_ENABLED = "true"
    delete process.env.MCA_SMS_ELIGIBILITY_REFERENCE
    assert.equal(await managedReady(owner.workspaceId, n.id), false)
    process.env.MCA_SMS_ELIGIBILITY_REFERENCE = eligibility
    await getDatabase().prepare("UPDATE sms_companies SET registration_state='pending' WHERE workspace_id=?").run(owner.workspaceId)
    assert.equal(await managedReady(owner.workspaceId, n.id), false)
    await getDatabase().prepare("UPDATE sms_companies SET registration_state='approved' WHERE workspace_id=?").run(owner.workspaceId)
    await saveProvider(owner.workspaceId, { ...p, campaignSid: undefined })
    assert.equal(await managedReady(owner.workspaceId, n.id), false)
    await saveProvider(owner.workspaceId, { ...p, brandSid: undefined })
    assert.equal(await managedReady(owner.workspaceId, n.id), false)
    await saveProvider(owner.workspaceId, { ...p, apiKeySecret: undefined })
    assert.equal(await managedReady(owner.workspaceId, n.id), false)
  } finally {
    if (cronEnabled === undefined) delete process.env.MCA_SMS_CRON_ENABLED
    else process.env.MCA_SMS_CRON_ENABLED = cronEnabled
    process.env.MCA_SMS_ELIGIBILITY_REFERENCE = eligibility
    await saveProvider(owner.workspaceId, p)
    await getDatabase().prepare("UPDATE sms_companies SET registration_state='approved' WHERE workspace_id=?").run(owner.workspaceId)
  }
})
test("managed send prerequisites apply with cron flag unset or non-enabling", async () => {
  const n = await getDatabase().prepare<{ id: string }>("SELECT id FROM sms_numbers WHERE workspace_id=?").get(owner.workspaceId)
  assert.ok(n)
  const cronEnabled = process.env.MCA_SMS_CRON_ENABLED
  try {
    delete process.env.MCA_SMS_CRON_ENABLED
    await saveProvider(owner.workspaceId, { ...p, brandSid: undefined })
    assert.equal(await managedReady(owner.workspaceId, n.id), false)
    await assert.rejects(
      withImmediateTransaction((db) => reserveManagedSend(db, actor, n.id, "missing-brand", "Application update", "+12125556666")),
      { code: "sms_setup_incomplete" }
    )
    const accounts = await listSmsAccounts(actor)
    assert.equal(accounts.accounts.find((account) => account.id === n.id)?.providerConfigured, false)
    await saveProvider(owner.workspaceId, { ...p, campaignSid: undefined })
    assert.equal(await managedReady(owner.workspaceId, n.id), false)
    await saveProvider(owner.workspaceId, { ...p, apiKeySecret: undefined })
    assert.equal(await managedReady(owner.workspaceId, n.id), false)
    process.env.MCA_SMS_CRON_ENABLED = "TRUE"
    assert.equal(await managedReady(owner.workspaceId, n.id), false)
    process.env.MCA_SMS_CRON_ENABLED = "true"
    assert.equal(await managedReady(owner.workspaceId, n.id), false)
    await saveProvider(owner.workspaceId, p)
    delete process.env.MCA_SMS_CRON_ENABLED
    assert.equal(await managedReady(owner.workspaceId, n.id), true)
  } finally {
    if (cronEnabled === undefined) delete process.env.MCA_SMS_CRON_ENABLED
    else process.env.MCA_SMS_CRON_ENABLED = cronEnabled
    await saveProvider(owner.workspaceId, p)
  }
})
test("employee removal, zero budget and missing Advanced Opt-Out all block managed sending", async () => {
  const n = await getDatabase()
    .prepare<{ id: string }>("SELECT id FROM sms_numbers WHERE workspace_id=?")
    .get(owner.workspaceId)
  await getDatabase()
    .prepare("UPDATE memberships SET status='deactivated' WHERE id=?")
    .run(owner.membershipId)
  assert.equal(await managedReady(owner.workspaceId, n!.id), false)
  await getDatabase()
    .prepare("UPDATE memberships SET status='active' WHERE id=?")
    .run(owner.membershipId)
  await getDatabase()
    .prepare("UPDATE sms_companies SET opt_out_ready=0 WHERE workspace_id=?")
    .run(owner.workspaceId)
  assert.equal(await managedReady(owner.workspaceId, n!.id), false)
  await getDatabase()
    .prepare(
      "UPDATE sms_companies SET opt_out_ready=1,monthly_limit_cents=0 WHERE workspace_id=?"
    )
    .run(owner.workspaceId)
  await assert.rejects(
    withImmediateTransaction((db) =>
      reserveManagedSend(
        db,
        actor,
        n!.id,
        "zero-budget",
        "Application update",
        "+12125556666"
      )
    ),
    { code: "sms_budget_exhausted" }
  )
  await assert.rejects(
    assignNumber(
      { ...actor, workspaceId: "other-company" },
      n!.id,
      owner.membershipId
    ),
    { code: "number_missing" }
  )
})
test("managed transport explicitly sends both the employee number and service SID", () => {
  const form = twilioMessageForm({
    accountSid: p.accountSid,
    apiKeySid: p.apiKeySid!,
    apiKeySecret: p.apiKeySecret!,
    senderKind: "phone_number",
    senderIdentity: "+12125554444",
    messagingServiceSid: p.serviceSid,
    recipient: "+12125556666",
    body: "Requested application update",
    statusCallbackUrl: "https://crm.example.test/callback",
    correlationId: "test",
  })
  assert.equal(form.get("From"), "+12125554444")
  assert.equal(form.get("MessagingServiceSid"), p.serviceSid)
})

test("managed send uses stored credentials, enforces legacy mutation isolation, and accepts callbacks after suspension",async()=>{
 const {deliverClosingSms,recordSmsConsent,updateSmsAccount,processTwilioStatus}=await import("../src/lib/mca/sms/service")
 await getDatabase().prepare("UPDATE sms_companies SET monthly_limit_cents=10000 WHERE workspace_id=?").run(owner.workspaceId)
 const n=await getDatabase().prepare<{id:string;phone:string}>("SELECT id,phone FROM sms_numbers WHERE workspace_id=?").get(owner.workspaceId)
 const recipient="+12125557777",dealId="managed-send-deal",messageSid=`SM${"7".repeat(32)}`
 await getDatabase().prepare("INSERT INTO deals (id,workspace_id,display_id,legal_name,contact_phone_cipher,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at) VALUES (?,?,?,'Synthetic application',?,'offer',1,'submission_ready','[]','{}',1,?,?)").run(dealId,owner.workspaceId,"SMS-MANAGED",encryptSensitive(recipient,owner.workspaceId),nowIso(),nowIso())
 await recordSmsConsent(actor,{dealId,recipient,state:"opted_in",evidence:"Direct application consent captured by test",idempotencyKey:"managed-consent"})
 await assert.rejects(updateSmsAccount(actor,n!.id,{memberIds:[owner.membershipId]}),{code:"managed_number_settings"})
 let sends=0
 const body="Your requested application is being reviewed."
 const result=await deliverClosingSms(actor,{dealId,recipient,body,senderAccountId:n!.id,idempotencyKey:"managed-send",correlationId:"managed-correlation",payloadHash:createHash("sha256").update(body).digest("hex"),deliveryMode:"never_attempted"},{send:async request=>{sends++;assert.equal(request.senderIdentity,n!.phone);assert.equal(request.messagingServiceSid,p.serviceSid);assert.equal(request.apiKeySid,p.apiKeySid);return {state:"accepted",externalId:messageSid}}})
 assert.equal(result.state,"accepted");assert.equal(sends,1)
 await getDatabase().prepare("UPDATE sms_companies SET suspended=1 WHERE workspace_id=?").run(owner.workspaceId)
 await assert.rejects(deliverClosingSms(actor,{dealId,recipient,body,senderAccountId:n!.id,idempotencyKey:"managed-suspended",correlationId:"managed-suspended",payloadHash:createHash("sha256").update(body).digest("hex"),deliveryMode:"never_attempted"},{send:async()=>{sends++;throw new Error("unexpected send")}}),{code:"sms_setup_incomplete"})
 assert.equal(sends,1)
 const url=`https://crm.example.test/api/mca/sms/webhooks/twilio/${n!.id}/status?messageId=${result.messageId}`
 const params=new URLSearchParams({AccountSid:p.accountSid,MessageSid:messageSid,MessageStatus:"delivered",From:n!.phone,To:recipient})
 const signature=createHmac("sha1",p.authToken).update(url+[...params.keys()].sort().map(k=>k+params.get(k)).join("")).digest("base64")
 assert.equal((await processTwilioStatus(n!.id,params,signature,url)).providerStatus,"delivered")
 await getDatabase().prepare("UPDATE sms_companies SET suspended=0 WHERE workspace_id=?").run(owner.workspaceId)
 await persistInbound(owner.workspaceId,n!.id,new URLSearchParams({From:recipient,To:n!.phone,Body:"STOP",OptOutType:"STOP",MessageSid:`SM${"6".repeat(32)}`}),"phone_number",n!.phone)
 await assert.rejects(deliverClosingSms(actor,{dealId,recipient,body,senderAccountId:n!.id,idempotencyKey:"managed-after-stop",correlationId:"managed-after-stop",payloadHash:createHash("sha256").update(body).digest("hex"),deliveryMode:"never_attempted"},{send:async()=>{sends++;throw new Error("unexpected send")}}),{code:"sms_recipient_opted_out"})
 assert.equal(sends,1)
})
test("replayed START cannot undo a newer STOP",async()=>{
 const from="+12125558888",to="+12125552222",make=(digit:string,type:string)=>new URLSearchParams({From:from,To:to,Body:type,OptOutType:type,MessageSid:`SM${digit.repeat(32)}`})
 await persistInbound(owner.workspaceId,"synthetic-route",make("8","START"),"phone_number",to)
 await persistInbound(owner.workspaceId,"synthetic-route",make("9","STOP"),"phone_number",to)
 await persistInbound(owner.workspaceId,"synthetic-route",make("8","START"),"phone_number",to)
 await assert.rejects(withImmediateTransaction(db=>assertNotSuppressed(db,owner.workspaceId,from)),{code:"sms_recipient_opted_out"})
})

test("company registration checkpoints the complete ISV workflow without sharing a brand",async()=>{
 const {refreshCompany}=await import("../src/lib/mca/sms/provisioning")
 process.env.MCA_SMS_COMPLIANCE_EMAIL="operator@example.test"
 const newOwner=await signUp({companyName:"Second company",name:"Second owner",email:"second@example.test",password:"AnotherSynthetic123",terms:true})
 const secondActor={...actor,workspaceId:newOwner.workspaceId,userId:newOwner.userId,membershipId:newOwner.membershipId}
 await getDatabase().prepare("UPDATE sms_companies SET email_verified_at=?,review_state='approved',profile_cipher=?,monthly_limit_cents=1000,registration_limit_cents=100 WHERE workspace_id=?").run(nowIso(),encryptSensitive(JSON.stringify(profileSchema.parse(profile)),newOwner.workspaceId),newOwner.workspaceId)
 const op=await requestProvisioning(secondActor,{kind:"register",idempotencyKey:"second-registration"})
 const calls:{host:string;path:string;method?:string}[]=[]
 const api:TwilioApi=async(config,host,path,method,data)=>{
   calls.push({host,path,method})
   if(path==="/2010-04-01/Accounts.json"){assert.equal(config,null);return {sid:`AC${"2".repeat(32)}`,auth_token:"second-auth"}}
   assert.equal(config?.accountSid,`AC${"2".repeat(32)}`)
   if(path.endsWith("Keys.json"))return {sid:`SK${"3".repeat(32)}`,secret:"second-api-secret"}
   if(path.endsWith("/Evaluations"))return {sid:`EL${"3".repeat(32)}`,status:"compliant"}
   if(!method||method==="GET")return path.includes("BrandRegistrations")?{status:"APPROVED"}:path.includes("Compliance/Usa2p")?{campaign_status:"VERIFIED"}:{status:"twilio-approved"}
   if(path==="/v1/a2p/BrandRegistrations"){assert.equal(data?.BrandType,"STANDARD");return {sid:`BN${"3".repeat(32)}`}}
   if(path==="/v1/Services")return {sid:`MG${"3".repeat(32)}`}
   if(path.endsWith("/Compliance/Usa2p")){assert.equal(data?.UsAppToPersonUsecase,"CUSTOMER_CARE");assert.equal(data?.PrivacyPolicyUrl,profile.privacyUrl);return {sid:`QE${"3".repeat(32)}`}}
   return {sid:`BU${"3".repeat(32)}`}
 }
 await runProvisioning(op.id,api)
 const operation=await getDatabase().prepare<{state:string;error_code:string}>("SELECT state,error_code FROM sms_operations WHERE id=?").get(op.id)
 assert.equal(operation?.state,"complete",operation?.error_code)
 await runProvisioning(op.id,api)
 assert.equal(calls.filter(c=>c.path==="/2010-04-01/Accounts.json").length,1)
 assert.ok(calls.some(c=>c.host==="events"&&c.path==="/v1/Subscriptions"))
 await refreshCompany(newOwner.workspaceId,api)
 assert.equal((await getDatabase().prepare<{registration_state:string}>("SELECT registration_state FROM sms_companies WHERE workspace_id=?").get(newOwner.workspaceId))?.registration_state,"approved")
})

test("default opt-out keywords and opt-in keywords update suppression with whitespace and case", async () => {
  const from = "+12125559001", to = "+12125552222"
  let sequence = 100
  const send = async (body: string, optOutType?: string) => {
    const params = new URLSearchParams({ From: from, To: to, Body: body, MessageSid: `SM${(sequence++).toString(16).padStart(32, "0")}` })
    if (optOutType) params.set("OptOutType", optOutType)
    await persistInbound(owner.workspaceId, "synthetic-keyword-route", params, "phone_number", to)
  }
  for (const word of ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]) {
    await send(`  ${word.toLowerCase()}  `)
    await assert.rejects(withImmediateTransaction(db => assertNotSuppressed(db, owner.workspaceId, from)), { code: "sms_recipient_opted_out" })
    await send("  yes  ")
    await withImmediateTransaction(db => assertNotSuppressed(db, owner.workspaceId, from))
  }
  for (const word of ["START", "UNSTOP", "YES"]) {
    await send(" stop ")
    await send(` ${word.toLowerCase()} `)
    await withImmediateTransaction(db => assertNotSuppressed(db, owner.workspaceId, from))
  }
  await send("ordinary text", "STOP")
  await send("ordinary text", "START")
  await withImmediateTransaction(db => assertNotSuppressed(db, owner.workspaceId, from))
})

test("manual evidence clears an earlier STOP but replayed evidence does not undo a later STOP", async () => {
  const { recordSmsConsent } = await import("../src/lib/mca/sms/service")
  const dealId = "manual-reoptin-deal", recipient = "+12125559002", to = "+12125552222"
  await getDatabase().prepare("INSERT INTO deals (id,workspace_id,display_id,legal_name,contact_phone_cipher,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at) VALUES (?,?,?,'Synthetic application',?,'offer',1,'submission_ready','[]','{}',1,?,?)").run(dealId, owner.workspaceId, "SMS-REOPTIN", encryptSensitive(recipient, owner.workspaceId), nowIso(), nowIso())
  const stop = async (digit: string) => persistInbound(owner.workspaceId, "synthetic-keyword-route", new URLSearchParams({ From: recipient, To: to, Body: "STOP", MessageSid: `SM${digit.repeat(32)}` }), "phone_number", to)
  await stop("a")
  const input = { dealId, recipient, state: "opted_in" as const, evidence: "Owner directly confirmed consent", idempotencyKey: "manual-reoptin" }
  assert.equal((await recordSmsConsent(actor, input)).created, true)
  await withImmediateTransaction(db => assertNotSuppressed(db, owner.workspaceId, recipient))
  await stop("b")
  assert.equal((await recordSmsConsent(actor, input)).created, false)
  await assert.rejects(withImmediateTransaction(db => assertNotSuppressed(db, owner.workspaceId, recipient)), { code: "sms_recipient_opted_out" })
})

test("registration route accepts object and string data and ignores irrelevant events", async () => {
  const { POST } = await import("../src/app/api/mca/sms/webhooks/registration/[workspaceId]/route")
  const number = await getDatabase().prepare<{ provider_sid: string }>("SELECT provider_sid FROM sms_numbers WHERE workspace_id=? LIMIT 1").get(owner.workspaceId)
  assert.ok(number)
  const data = { accountsid: p.accountSid, messagingservicesid: p.serviceSid, phonenumbersid: number.provider_sid, externalstatus: "registered" }
  let sequence = 0
  const send = async (type: string, value: unknown, array = false, valid = true) => {
    const envelope = { id: `route-event-${++sequence}`, type, time: new Date().toISOString(), data: value }
    const raw = JSON.stringify(array ? [envelope] : envelope)
    const hash = createHash("sha256").update(raw).digest("hex")
    const url = `https://crm.example.test/api/mca/sms/webhooks/registration/${owner.workspaceId}?bodySHA256=${hash}`
    const signature = createHmac("sha1", p.authToken).update(url).digest("base64")
    return POST(new Request(url, { method: "POST", headers: { "x-twilio-signature": valid ? signature : "bad" }, body: raw }), { params: Promise.resolve({ workspaceId: owner.workspaceId }) })
  }
  const type = "com.twilio.messaging.compliance.number-registration.successful"
  assert.equal((await send(type, data)).status, 200)
  assert.equal((await send(type, JSON.stringify(data), true)).status, 200)
  assert.equal((await send("unrelated", data)).status, 204)
  assert.equal((await send(type, { ...data, externalstatus: "future_status" })).status, 204)
  assert.equal((await send(type, "{broken")).status, 422)
  assert.equal((await send(type, { ...data, accountsid: "wrong" })).status, 401)
  assert.equal((await send(type, data, false, false)).status, 401)
})

test("Twilio 21610 suppresses a recipient after a failed send", async () => {
  const { recordSmsConsent, deliverClosingSms } = await import("../src/lib/mca/sms/service")
  const recipient = "+12125557777", dealId = "managed-send-deal"
  const account = await getDatabase().prepare<{ id: string }>("SELECT id FROM sms_numbers WHERE workspace_id=? AND state='active' LIMIT 1").get(owner.workspaceId)
  assert.ok(account)
  await recordSmsConsent(actor, { dealId, recipient, state: "opted_in", evidence: "Owner reconfirmed consent", idempotencyKey: "retry-after-stop" })
  const body = "Synthetic delivery error test", payloadHash = createHash("sha256").update(body).digest("hex")
  const input = { dealId, recipient, body, senderAccountId: account.id, idempotencyKey: "sms-21610-one", correlationId: "sms-21610", payloadHash, deliveryMode: "never_attempted" as const }
  const result = await deliverClosingSms(actor, input, { send: async () => ({ state: "failed", errorCode: "twilio_21610", errorMessage: "Recipient unsubscribed" }) })
  assert.equal(result.errorCode, "twilio_21610")
  await assert.rejects(deliverClosingSms(actor, { ...input, idempotencyKey: "sms-21610-two" }, { send: async () => { throw new Error("must not send") } }), { code: "sms_recipient_opted_out" })
  const { processTwilioOptOut } = await import("../src/lib/mca/sms/service")
  const number = await getDatabase().prepare<{ phone: string }>("SELECT phone FROM sms_numbers WHERE id=?").get(account.id)
  const params = new URLSearchParams({ AccountSid: p.accountSid, From: recipient, To: number!.phone, Body: "  yes  ", MessageSid: `SM${"e".repeat(32)}` })
  const url = `https://crm.example.test/api/mca/sms/webhooks/twilio/${account.id}/inbound`
  const signature = createHmac("sha1", p.authToken).update(url + [...params.keys()].sort().map(key => key + params.get(key)).join("")).digest("base64")
  assert.equal((await processTwilioOptOut(account.id, params, signature, url)).updated, 1)
  const consent = await getDatabase().prepare<{ source: string; state: string }>("SELECT source,state FROM mca_sms_consent_events WHERE workspace_id=? AND deal_id=? AND source='keyword' ORDER BY created_at DESC LIMIT 1").get(owner.workspaceId, dealId)
  assert.equal(consent?.source, "keyword")
  assert.equal(consent?.state, "opted_in")
  await withImmediateTransaction(db => assertNotSuppressed(db, owner.workspaceId, recipient))
})

test("purchase attempt keys dedupe a double submit and advance after failure or release", async () => {
  await getDatabase().prepare("UPDATE sms_companies SET registration_state='approved',opt_out_ready=1,monthly_limit_cents=10000 WHERE workspace_id=?").run(owner.workspaceId)
  await getDatabase().prepare("UPDATE sms_operations SET state='failed' WHERE workspace_id=? AND state NOT IN ('complete','failed')").run(owner.workspaceId)
  await getDatabase().prepare("UPDATE sms_numbers SET state='released',membership_id=NULL WHERE workspace_id=? AND membership_id=?").run(owner.workspaceId, owner.membershipId)
  const firstInput = { kind: "purchase" as const, phone: "+12125559003", membershipId: owner.membershipId, maxMonthlyCents: 115 }
  const [first, duplicate] = await Promise.all([requestProvisioning(actor, firstInput), requestProvisioning(actor, firstInput)])
  assert.equal(first.id, duplicate.id)
  const firstKey = await getDatabase().prepare<{ request_key: string }>("SELECT request_key FROM sms_operations WHERE id=?").get(first.id)
  assert.match(firstKey!.request_key, new RegExp(`^buy:${owner.workspaceId}:\\d+$`))
  await getDatabase().prepare("UPDATE sms_operations SET state='failed' WHERE id=?").run(first.id)
  const retry = await requestProvisioning(actor, firstInput)
  assert.notEqual(retry.id, first.id)
  const retryKey = await getDatabase().prepare<{ request_key: string }>("SELECT request_key FROM sms_operations WHERE id=?").get(retry.id)
  assert.notEqual(retryKey!.request_key, firstKey!.request_key)
  await getDatabase().prepare("UPDATE sms_operations SET state='complete' WHERE id=?").run(retry.id)
  await getDatabase().prepare("UPDATE sms_numbers SET state='active',phone=?,membership_id=? WHERE id=(SELECT id FROM sms_numbers WHERE workspace_id=? AND state='released' LIMIT 1)").run(firstInput.phone, owner.membershipId, owner.workspaceId)
  assert.equal((await requestProvisioning(actor, firstInput)).id, retry.id)
  await getDatabase().prepare("UPDATE sms_numbers SET state='released',membership_id=NULL WHERE workspace_id=? AND membership_id=?").run(owner.workspaceId, owner.membershipId)
  const rebuy = await requestProvisioning(actor, firstInput)
  assert.notEqual(rebuy.id, retry.id)
  await getDatabase().prepare("UPDATE sms_operations SET state='failed' WHERE id=?").run(rebuy.id)
  const otherUser = "purchase-second-user", otherMember = "purchase-second-member", now = nowIso()
  await getDatabase().prepare("INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(otherUser, "purchase-second@example.test", "Second employee", otherUser, now, now)
  await getDatabase().prepare("INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,? ,?,'rep','active',?,?)").run(otherMember, owner.workspaceId, otherUser, now, now)
  const other = await requestProvisioning(actor, { ...firstInput, membershipId: otherMember })
  assert.notEqual(other.id, rebuy.id)
  await getDatabase().prepare("UPDATE sms_operations SET state='failed' WHERE id=?").run(other.id)
})

test("SMS account listing degrades gracefully when the legacy public origin is misconfigured", async () => {
  const previous = process.env.MCA_SMS_PUBLIC_BASE_URL
  try {
    process.env.MCA_SMS_PUBLIC_BASE_URL = "not-a-url"
    assert.equal((await listSmsAccounts(actor)).publicOrigin, null)
    process.env.MCA_SMS_PUBLIC_BASE_URL = "https://fundlane.io"
    assert.equal((await listSmsAccounts(actor)).publicOrigin, "https://fundlane.io")
  } finally {
    if (previous === undefined) delete process.env.MCA_SMS_PUBLIC_BASE_URL
    else process.env.MCA_SMS_PUBLIC_BASE_URL = previous
  }
})
