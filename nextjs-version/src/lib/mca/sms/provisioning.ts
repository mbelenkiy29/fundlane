import "server-only"
import { z } from "zod"
import {
  getDatabase,
  withImmediateTransaction,
  newId,
  nowIso,
  recordAuditEvent,
  type DbExecutor,
} from "../db"
import { encryptSensitive, decryptSensitive } from "../crypto"
import { AppError } from "../errors"
import { executionSignal } from "../jobs/execution"
import {
  company,
  provider,
  saveProvider,
  admin,
  platformReady,
  publicOrigin,
  type Company,
  type ProviderConfig,
  type BusinessProfile,
} from "./onboarding"
import type { DealActor } from "../deals/schema"

type Json = Record<string, unknown>
export type TwilioApi = (
  p: ProviderConfig | null,
  host: "api" | "messaging" | "trusthub" | "pricing" | "events",
  path: string,
  method?: "GET" | "POST" | "DELETE",
  data?: Record<string, string | string[]>
) => Promise<Json>
export const twilioApi: TwilioApi = async (
  p,
  host,
  path,
  method = "GET",
  data
) => {
  const sid = p?.accountSid ?? process.env.MCA_TWILIO_PARENT_ACCOUNT_SID,
    token = p?.authToken ?? process.env.MCA_TWILIO_PARENT_AUTH_TOKEN
  if (!sid || !token)
    throw new AppError(
      503,
      "twilio_credentials_missing",
      "Twilio provisioning credentials are not configured."
    )
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(data ?? {}))
    for (const item of Array.isArray(v) ? v : [v]) form.append(k, item)
  const deadlineSignal = executionSignal()
  const response = await fetch(`https://${host}.twilio.com${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      ...(method === "POST"
        ? { "content-type": "application/x-www-form-urlencoded" }
        : {}),
    },
    body: method === "POST" ? form : undefined,
    signal: deadlineSignal
      ? AbortSignal.any([deadlineSignal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    redirect: "error",
  })
  if (response.status === 204) return {}
  const body = (await response.json().catch(() => ({}))) as Json
  if (!response.ok)
    throw new AppError(
      response.status >= 500 ? 502 : 422,
      `twilio_${String(body.code ?? response.status).replace(/[^0-9]/g, "")}`,
      "Twilio could not complete this step. Review the registration diagnostics."
    )
  return body
}
const idKey = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/)
export const provisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("register"), idempotencyKey: idKey }),
  z.object({
    kind: z.literal("purchase"),
    idempotencyKey: idKey.optional(),
    phone: z.string().regex(/^\+1\d{10}$/),
    membershipId: z.string().min(1),
    maxMonthlyCents: z.number().int().positive().max(10000),
  }),
  z.object({
    kind: z.literal("release"),
    idempotencyKey: idKey,
    numberId: z.string().min(1),
  }),
])
type Operation = {
  created_at: string
  id: string
  workspace_id: string
  kind: string
  state: string
  step: string | null
  payload_cipher: string
  result_cipher: string | null
  lease_until: string | null
}
function centsEnv(name: string): number {
  const n = Number(process.env[name])
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new AppError(
      503,
      "sms_pricing_missing",
      "The platform operator must configure conservative cost estimates."
    )
  return n
}
export function assertProvisionable(
  c: Company | undefined,
  registered = false
) {
  if (
    !c?.email_verified_at ||
    c.review_state !== "approved" ||
    c.suspended ||
    !platformReady()
  )
    throw new AppError(
      409,
      "sms_onboarding_required",
      "Complete company verification and platform activation first."
    )
  if (registered && c.registration_state !== "approved")
    throw new AppError(
      409,
      "carrier_approval_required",
      "Carrier approval is required first."
    )
}
export async function reserveUsage(
  db: DbExecutor,
  c: Company,
  id: string,
  category: string,
  cents: number,
  period = nowIso().slice(0, 7)
) {
  if (await db.prepare("SELECT id FROM sms_usage WHERE id=?").get(id)) return
  const used = await db
    .prepare<{
      total: string
    }>("SELECT COALESCE(sum(estimated_cents),0)::text total FROM sms_usage WHERE workspace_id=? AND period=?")
    .get(c.workspace_id, period)
  const actual = await db
    .prepare<{
      total: string
    }>("SELECT COALESCE(sum(actual_cents),0)::text total FROM sms_usage WHERE workspace_id=? AND period=? AND category='provider_total'")
    .get(c.workspace_id, period)
  if (
    Number(used?.total ?? 0) + Number(actual?.total ?? 0) + cents >
    c.monthly_limit_cents
  )
    throw new AppError(
      409,
      "sms_budget_exhausted",
      "The company SMS allowance is exhausted. Contact your administrator."
    )
  await db
    .prepare(
      "INSERT INTO sms_usage (id,workspace_id,period,category,estimated_cents,updated_at) VALUES (?,?,?,?,?,?)"
    )
    .run(id, c.workspace_id, period, category, cents, nowIso())
}
export async function requestProvisioning(
  actor: DealActor,
  input: z.infer<typeof provisionSchema>
) {
  admin(actor)
  return withImmediateTransaction(async (db) => {
    const c = await db
      .prepare<Company>(
        "SELECT * FROM sms_companies WHERE workspace_id=? FOR UPDATE"
      )
      .get(actor.workspaceId)
    let requestKey: string
    let encoded: string
    if (input.kind === "purchase") {
      const previous = await db.prepare<Operation>("SELECT * FROM sms_operations WHERE workspace_id=? AND kind='purchase' ORDER BY created_at DESC,id DESC").all(actor.workspaceId)
      const intent = { kind: input.kind, phone: input.phone, membershipId: input.membershipId, maxMonthlyCents: input.maxMonthlyCents }
      for (const operation of previous) {
        const stored = JSON.parse(decryptSensitive(operation.payload_cipher, actor.workspaceId)) as typeof intent
        if (stored.phone !== intent.phone || stored.membershipId !== intent.membershipId || stored.maxMonthlyCents !== intent.maxMonthlyCents) continue
        if (["queued", "running", "needs_review"].includes(operation.state)) return { id: operation.id, state: operation.state }
        if (operation.state === "complete" && await db.prepare("SELECT id FROM sms_numbers WHERE workspace_id=? AND phone=? AND membership_id=? AND state<>'released'").get(actor.workspaceId, input.phone, input.membershipId)) return { id: operation.id, state: operation.state }
      }
      requestKey = `buy:${actor.workspaceId}:${previous.length + 1}`
      encoded = JSON.stringify({ ...intent, idempotencyKey: requestKey })
    } else {
      requestKey = input.idempotencyKey
      encoded = JSON.stringify(input)
      const old = await db.prepare<Operation>("SELECT * FROM sms_operations WHERE workspace_id=? AND request_key=?").get(actor.workspaceId, requestKey)
      if (old) {
        if (decryptSensitive(old.payload_cipher, actor.workspaceId) !== encoded) throw new AppError(409, "idempotency_conflict", "That retry key identifies a different request.")
        return { id: old.id, state: old.state }
      }
    }
    if (!c)
      throw new AppError(
        409,
        "company_missing",
        "Start company onboarding first."
      )
    if (input.kind !== "release")
      assertProvisionable(c, input.kind === "purchase")
    const pending = await db
      .prepare(
        "SELECT id FROM sms_operations WHERE workspace_id=? AND state NOT IN ('complete','failed') LIMIT 1"
      )
      .get(actor.workspaceId)
    if (pending)
      throw new AppError(
        409,
        "sms_operation_pending",
        "An SMS operation is already in progress. Resolve it before starting another."
      )
    const id = newId()
    if (input.kind === "register") {
      if (c.provider_cipher)
        throw new AppError(
          409,
          "registration_exists",
          "Registration already exists; refresh its status instead."
        )
      const fee = centsEnv("MCA_SMS_REGISTRATION_ESTIMATE_CENTS")
      if (fee > c.registration_limit_cents)
        throw new AppError(
          409,
          "registration_budget_required",
          "An operator must approve the registration allowance."
        )
      await reserveUsage(db, c, id, "registration", fee)
    }
    if (input.kind === "purchase") {
      if (
        !(await db
          .prepare(
            "SELECT id FROM memberships WHERE workspace_id=? AND id=? AND status='active'"
          )
          .get(actor.workspaceId, input.membershipId))
      )
        throw new AppError(422, "member_invalid", "Select an active employee.")
      const count = await db
        .prepare<{
          n: number
        }>("SELECT count(*)::int n FROM sms_numbers WHERE workspace_id=? AND state<>'released'")
        .get(actor.workspaceId)
      if ((count?.n ?? 0) >= c.number_limit)
        throw new AppError(
          409,
          "number_limit",
          "The company number allowance is exhausted."
        )
      if (
        await db
          .prepare(
            "SELECT id FROM sms_numbers WHERE workspace_id=? AND membership_id=? AND state<>'released'"
          )
          .get(actor.workspaceId, input.membershipId)
      )
        throw new AppError(
          409,
          "employee_has_number",
          "This employee already has a number."
        )
      await reserveUsage(db, c, id, "number_rental", input.maxMonthlyCents)
    }
    if (
      input.kind === "release" &&
      !(await db
        .prepare(
          "SELECT id FROM sms_numbers WHERE workspace_id=? AND id=? AND state<>'released'"
        )
        .get(actor.workspaceId, input.numberId))
    )
      throw new AppError(404, "number_missing", "Number not found.")
    await db
      .prepare(
        "INSERT INTO sms_operations (id,workspace_id,kind,request_key,payload_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?,?)"
      )
      .run(
        id,
        actor.workspaceId,
        input.kind,
        requestKey,
        encryptSensitive(encoded, actor.workspaceId),
        nowIso(),
        nowIso()
      )
    if (input.kind === "register") await db.prepare("UPDATE sms_companies SET registration_state='provisioning',updated_at=? WHERE workspace_id=?").run(nowIso(),actor.workspaceId)
    await recordAuditEvent({
      context: actor,
      action: `sms.${input.kind}_requested`,
      resourceType: "sms_operation",
      resourceId: id,
    })
    return { id, state: "queued" }
  })
}
export async function numberSearch(
  actor: DealActor,
  areaCode: string,
  api: TwilioApi = twilioApi
) {
  admin(actor)
  if (!/^[2-9]\d{2}$/.test(areaCode))
    throw new AppError(
      422,
      "area_code_invalid",
      "Enter a three digit US area code."
    )
  const c = await company(actor.workspaceId)
  assertProvisionable(c, true)
  const p = provider(c!)!
  const price = await api(p, "pricing", "/v1/PhoneNumbers/Countries/US")
  const local = (price.phone_number_prices as Json[] | undefined)?.find(
    (x) => x.number_type === "local"
  )
  const monthlyCents = Math.ceil(Number(local?.current_price) * 100)
  if (
    price.price_unit !== "USD" ||
    !Number.isSafeInteger(monthlyCents) ||
    monthlyCents <= 0
  )
    throw new AppError(
      503,
      "pricing_unavailable",
      "Current US number pricing is unavailable."
    )
  const result = await api(
    p,
    "api",
    `/2010-04-01/Accounts/${p.accountSid}/AvailablePhoneNumbers/US/Local.json?AreaCode=${areaCode}&SmsEnabled=true&PageSize=10`
  )
  return {
    numbers: ((result.available_phone_numbers ?? []) as Json[]).map((n) => ({
      phone: n.phone_number,
      locality: n.locality,
      monthlyCents,
      currency: "USD",
    })),
    notice:
      "Monthly rental plus SMS and carrier charges. Availability is confirmed at purchase.",
  }
}
async function registrationStatus(c: Company, api: TwilioApi) {
  const p = provider(c)
  if (!p?.campaignSid || !p.serviceSid) return false
  const result = await api(
    p,
    "messaging",
    `/v1/Services/${p.serviceSid}/Compliance/Usa2p/${p.campaignSid}`
  )
  const state =
    result.campaign_status === "VERIFIED"
      ? "approved"
      : ["FAILED", "REJECTED", "SUSPENDED"].includes(
            String(result.campaign_status)
          )
        ? "rejected"
        : "pending"
  await getDatabase()
    .prepare(
      "UPDATE sms_companies SET registration_state=?,updated_at=? WHERE workspace_id=? AND registration_state IS DISTINCT FROM ?"
    )
    .run(state, nowIso(), c.workspace_id, state)
  return state === "approved"
}
export async function runProvisioning(id: string, api: TwilioApi = twilioApi) {
  const op = await withImmediateTransaction(async (db) => {
    const row = await db
      .prepare<Operation>("SELECT * FROM sms_operations WHERE id=? FOR UPDATE")
      .get(id)
    if (!row || ["complete", "failed", "needs_review"].includes(row.state))
      return undefined
    if (row.lease_until && row.lease_until > nowIso()) return undefined
    if (!(await (await import("../company-access")).getCompanyAccess(row.workspace_id)).allowed) {
      await db.prepare("UPDATE sms_operations SET state='needs_review',error_code='company_paused',lease_until=NULL,updated_at=? WHERE id=?").run(nowIso(), id)
      return undefined
    }
    // A lost response must never cause a second paid creation.
    if (row.state === "running") {
      await db
        .prepare(
          "UPDATE sms_operations SET state='needs_review',error_code='provider_outcome_unknown',lease_until=NULL WHERE id=?"
        )
        .run(id)
      return undefined
    }
    await db
      .prepare(
        "UPDATE sms_operations SET state='running',lease_until=?,updated_at=? WHERE id=?"
      )
      .run(new Date(Date.now() + 120000).toISOString(), nowIso(), id)
    return row
  })
  if (!op) return
  const providerApi = api
  api = async (...args) => {
    await (await import("../company-access")).assertCompanyOperational(op.workspace_id)
    await (await import("../outbound-approval")).assertOutboundDispatch(op.workspace_id, op.created_at)
    return providerApi(...args)
  }
  const c = (await company(op.workspace_id))!,
    input = JSON.parse(
      decryptSensitive(op.payload_cipher, op.workspace_id)
    ) as z.infer<typeof provisionSchema>
  const results: Record<string, Json> = op.result_cipher
    ? JSON.parse(decryptSensitive(op.result_cipher, op.workspace_id))
    : {}
  let p = provider(c)
  const step = async (
    name: string,
    host: "api" | "messaging" | "trusthub" | "events",
    path: string,
    data: Record<string, string | string[]>,
    method: "POST" | "DELETE" = "POST"
  ) => {
    if (results[name]) return results[name]
    await getDatabase()
      .prepare(
        "UPDATE sms_operations SET step=?,lease_until=?,updated_at=? WHERE id=?"
      )
      .run(name, new Date(Date.now() + 120000).toISOString(), nowIso(), id)
    const value = await api(p ?? null, host, path, method, data)
    results[name] = value
    await getDatabase()
      .prepare(
        "UPDATE sms_operations SET result_cipher=?,step=NULL,updated_at=? WHERE id=?"
      )
      .run(
        encryptSensitive(JSON.stringify(results), op.workspace_id),
        nowIso(),
        id
      )
    return value
  }
  const wait = async () => {
    await getDatabase()
      .prepare(
        "UPDATE sms_operations SET state='queued',step=NULL,lease_until=NULL,updated_at=? WHERE id=?"
      )
      .run(nowIso(), id)
  }
  try {
    if (input.kind !== "release")
      assertProvisionable(c, input.kind === "purchase")
    if (input.kind === "register") {
      const b = JSON.parse(
        decryptSensitive(c.profile_cipher!, c.workspace_id)
      ) as BusinessProfile
      const email = process.env.MCA_SMS_COMPLIANCE_EMAIL
      if (!email)
        throw new AppError(
          503,
          "compliance_email_missing",
          "Configure the platform compliance mailbox."
        )
      if (!p) {
        const sub = await step(
          "subaccount",
          "api",
          "/2010-04-01/Accounts.json",
          { FriendlyName: `Fundlane ${c.workspace_id}` }
        )
        p = { accountSid: String(sub.sid), authToken: String(sub.auth_token) }
        await saveProvider(c.workspace_id, p)
      }
      if (!p.apiKeySid) {
        const key = await step(
          "api_key",
          "api",
          `/2010-04-01/Accounts/${p.accountSid}/Keys.json`,
          { FriendlyName: `Fundlane SMS ${id}` }
        )
        p.apiKeySid = String(key.sid)
        p.apiKeySecret = String(key.secret)
        await saveProvider(c.workspace_id, p)
      }
      const base = { FriendlyName: `Fundlane ${c.workspace_id}`, Email: email }
      const profile = await step(
        "profile",
        "trusthub",
        "/v1/CustomerProfiles",
        { ...base, PolicySid: "RNdfbf3fae0e1107f8aded0e7cead80bf5" }
      )
      p.profileSid = String(profile.sid)
      const business = await step("business", "trusthub", "/v1/EndUsers", {
        FriendlyName: base.FriendlyName,
        Type: "customer_profile_business_information",
        Attributes: JSON.stringify({
          business_name: b.legalName,
          business_type: b.businessType,
          business_registration_identifier: "EIN",
          business_registration_number: b.ein.replace(/-/g, ""),
          business_identity: "direct_customer",
          business_industry: "FINANCIAL_SERVICES",
          business_regions_of_operation: "USA_AND_CANADA",
          website_url: b.website,
        }),
      })
      const representative = await step(
        "representative",
        "trusthub",
        "/v1/EndUsers",
        {
          FriendlyName: base.FriendlyName,
          Type: "authorized_representative_1",
          Attributes: JSON.stringify({
            first_name: b.contactFirstName,
            last_name: b.contactLastName,
            email: b.contactEmail,
            phone_number: b.contactPhone,
            job_position: b.contactPosition,
            business_title: b.contactTitle,
          }),
        }
      )
      const address = await step(
        "address",
        "api",
        `/2010-04-01/Accounts/${p.accountSid}/Addresses.json`,
        {
          CustomerName: b.legalName,
          Street: b.street,
          City: b.city,
          Region: b.region,
          PostalCode: b.postalCode,
          IsoCountry: "US",
        }
      )
      const doc = await step(
        "address_document",
        "trusthub",
        "/v1/SupportingDocuments",
        {
          FriendlyName: base.FriendlyName,
          Type: "customer_profile_address",
          Attributes: JSON.stringify({ address_sids: address.sid }),
        }
      )
      for (const [name, sid] of [
        ["business", business.sid],
        ["representative", representative.sid],
        ["address", doc.sid],
        ["primary", process.env.MCA_TWILIO_PRIMARY_PROFILE_SID],
      ])
        await step(
          `profile_${name}`,
          "trusthub",
          `/v1/CustomerProfiles/${p.profileSid}/EntityAssignments`,
          { ObjectSid: String(sid) }
        )
      const evaluation = await step(
        "profile_evaluation",
        "trusthub",
        `/v1/CustomerProfiles/${p.profileSid}/Evaluations`,
        { PolicySid: "RNdfbf3fae0e1107f8aded0e7cead80bf5" }
      )
      if (evaluation.status !== "compliant")
        throw new AppError(
          422,
          "profile_noncompliant",
          "Business profile requires correction by the operator."
        )
      await step(
        "profile_submit",
        "trusthub",
        `/v1/CustomerProfiles/${p.profileSid}`,
        { Status: "pending-review" }
      )
      const trust = await step("trust", "trusthub", "/v1/TrustProducts", {
        ...base,
        PolicySid: "RNb0d4771c2c98518d916a3d4cd70a8f8b",
      })
      p.trustSid = String(trust.sid)
      const messaging = await step(
        "messaging_profile",
        "trusthub",
        "/v1/EndUsers",
        {
          FriendlyName: base.FriendlyName,
          Type: "us_a2p_messaging_profile_information",
          Attributes: JSON.stringify({ company_type: "private" }),
        }
      )
      await step(
        "trust_messaging",
        "trusthub",
        `/v1/TrustProducts/${p.trustSid}/EntityAssignments`,
        { ObjectSid: String(messaging.sid) }
      )
      await step(
        "trust_profile",
        "trusthub",
        `/v1/TrustProducts/${p.trustSid}/EntityAssignments`,
        { ObjectSid: p.profileSid }
      )
      const te = await step(
        "trust_evaluation",
        "trusthub",
        `/v1/TrustProducts/${p.trustSid}/Evaluations`,
        { PolicySid: "RNb0d4771c2c98518d916a3d4cd70a8f8b" }
      )
      if (te.status !== "compliant")
        throw new AppError(
          422,
          "trust_noncompliant",
          "Messaging profile requires operator review."
        )
      await step(
        "trust_submit",
        "trusthub",
        `/v1/TrustProducts/${p.trustSid}`,
        { Status: "pending-review" }
      )
      await saveProvider(c.workspace_id, p)
      const ps = await api(
          p,
          "trusthub",
          `/v1/CustomerProfiles/${p.profileSid}`
        ),
        ts = await api(p, "trusthub", `/v1/TrustProducts/${p.trustSid}`)
      if ([ps.status, ts.status].includes("twilio-rejected"))
        throw new AppError(
          422,
          "profile_rejected",
          "Twilio rejected the company profile."
        )
      if (ps.status !== "twilio-approved" || ts.status !== "twilio-approved") {
        await wait()
        return
      }
      const brand = await step(
        "brand",
        "messaging",
        "/v1/a2p/BrandRegistrations",
        {
          CustomerProfileBundleSid: p.profileSid,
          A2PProfileBundleSid: p.trustSid,
          BrandType: "STANDARD",
        }
      )
      p.brandSid = String(brand.sid)
      await saveProvider(c.workspace_id, p)
      const bs = await api(
        p,
        "messaging",
        `/v1/a2p/BrandRegistrations/${p.brandSid}`
      )
      if (bs.status === "FAILED")
        throw new AppError(422, "brand_rejected", "Twilio rejected the brand.")
      if (bs.status !== "APPROVED") {
        await wait()
        return
      }
      const service = await step("service", "messaging", "/v1/Services", {
        FriendlyName: base.FriendlyName,
        UseInboundWebhookOnNumber: "true",
      })
      p.serviceSid = String(service.sid)
      await saveProvider(c.workspace_id, p)
      const sink = await step("event_sink", "events", "/v1/Sinks", {
        Description: base.FriendlyName,
        SinkType: "webhook",
        SinkConfiguration: JSON.stringify({
          destination: `${publicOrigin()}/api/mca/sms/webhooks/registration/${c.workspace_id}`,
          method: "POST",
          batch_events: true,
        }),
      })
      await step("event_subscription", "events", "/v1/Subscriptions", {
        Description: base.FriendlyName,
        SinkSid: String(sink.sid),
        Types: ["successful", "failed", "pending"].map((state) =>
          JSON.stringify({
            type: `com.twilio.messaging.compliance.number-registration.${state}`,
            schema_version: 1,
          })
        ),
      })
      const campaign = await step(
        "campaign",
        "messaging",
        `/v1/Services/${p.serviceSid}/Compliance/Usa2p`,
        {
          BrandRegistrationSid: p.brandSid,
          UsAppToPersonUsecase: "CUSTOMER_CARE",
          Description: b.purpose,
          MessageFlow: b.consentEvidence,
          MessageSamples: b.samples,
          HasEmbeddedLinks: "true",
          HasEmbeddedPhone: "true",
          PrivacyPolicyUrl: b.privacyUrl,
          TermsAndConditionsUrl: b.termsUrl,
        }
      )
      p.campaignSid = String(campaign.sid)
      await saveProvider(c.workspace_id, p)
      await getDatabase()
        .prepare(
          "UPDATE sms_companies SET registration_state='pending',updated_at=? WHERE workspace_id=?"
        )
        .run(nowIso(), c.workspace_id)
    }
    if (input.kind === "purchase") {
      p = provider(c)!
      if (
        !(await getDatabase()
          .prepare(
            "SELECT id FROM memberships WHERE id=? AND workspace_id=? AND status='active'"
          )
          .get(input.membershipId, c.workspace_id))
      )
        throw new AppError(
          409,
          "employee_inactive",
          "The employee is no longer active."
        )
      if (!results.purchase) {
        const count = await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM sms_numbers WHERE workspace_id=? AND state<>'released'").get(c.workspace_id)
        const reserved = await getDatabase().prepare<{n:string}>("SELECT COALESCE(sum(estimated_cents),0)::text n FROM sms_usage WHERE workspace_id=? AND period=?").get(c.workspace_id,nowIso().slice(0,7))
        if ((count?.n??0)>=c.number_limit || Number(reserved?.n??0)>c.monthly_limit_cents) throw new AppError(409,"sms_allowance_changed","The operator reduced the company allowance. Review limits before purchasing.")
        const price = await api(p, "pricing", "/v1/PhoneNumbers/Countries/US"),
          local = (price.phone_number_prices as Json[] | undefined)?.find(
            (x) => x.number_type === "local"
          )
        if (
          price.price_unit !== "USD" ||
          !local ||
          !Number.isFinite(Number(local.current_price)) ||
          Math.ceil(Number(local.current_price) * 100) > input.maxMonthlyCents
        )
          throw new AppError(
            409,
            "price_changed",
            "Number pricing changed. Review the price before purchasing."
          )
      }
      const number = await step(
        "purchase",
        "api",
        `/2010-04-01/Accounts/${p.accountSid}/IncomingPhoneNumbers.json`,
        {
          PhoneNumber: input.phone,
          FriendlyName: `Fundlane ${id}`,
          SmsUrl: `${publicOrigin()}/api/mca/sms/webhooks/twilio/${id}/inbound`,
          SmsMethod: "POST",
        }
      )
      await withImmediateTransaction(async (db) => {
        await db
          .prepare(
            "SELECT workspace_id FROM sms_companies WHERE workspace_id=? FOR UPDATE"
          )
          .get(c.workspace_id)
        await db
          .prepare(
            "INSERT INTO sms_numbers (id,workspace_id,account_id,provider_sid,phone,membership_id,state,monthly_cents,created_at,updated_at) VALUES (?,?,?,?,?,?,'registering',?,?,?) ON CONFLICT (provider_sid) DO NOTHING"
          )
          .run(
            id,
            c.workspace_id,
            id,
            String(number.sid),
            input.phone,
            input.membershipId,
            input.maxMonthlyCents,
            nowIso(),
            nowIso()
          )
        await db
          .prepare(
            "INSERT INTO mca_sms_accounts (id,workspace_id,provider,label,sender_kind,sender_identity_cipher,credential_ref,state,is_default,created_at,updated_at) VALUES (?,?,'twilio',?,'phone_number',?,'MANAGED','active',0,?,?) ON CONFLICT (id) DO NOTHING"
          )
          .run(
            id,
            c.workspace_id,
            `Employee ${input.phone}`,
            encryptSensitive(input.phone, c.workspace_id),
            nowIso(),
            nowIso()
          )
        await db
          .prepare(
            "INSERT INTO mca_sms_account_members (workspace_id,account_id,membership_id,assigned_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING"
          )
          .run(c.workspace_id, id, input.membershipId, nowIso())
        await db
          .prepare(
            "INSERT INTO sms_number_assignments (id,workspace_id,number_id,membership_id,actor_user_id,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING"
          )
          .run(
            id,
            c.workspace_id,
            id,
            input.membershipId,
            c.owner_user_id,
            nowIso()
          )
      })
      await step(
        "attach",
        "messaging",
        `/v1/Services/${p.serviceSid}/PhoneNumbers`,
        { PhoneNumberSid: String(number.sid) }
      )
    }
    if (input.kind === "release") {
      p = provider(c)!
      const number = await getDatabase()
        .prepare<{
          provider_sid: string
          account_id: string
        }>("SELECT provider_sid,account_id FROM sms_numbers WHERE workspace_id=? AND id=?")
        .get(c.workspace_id, input.numberId)
      if (!number)
        throw new AppError(404, "number_missing", "Number not found.")
      await getDatabase()
        .prepare(
          "UPDATE sms_numbers SET state='releasing',updated_at=? WHERE id=? AND workspace_id=?"
        )
        .run(nowIso(), input.numberId, c.workspace_id)
      await step(
        "release",
        "api",
        `/2010-04-01/Accounts/${p.accountSid}/IncomingPhoneNumbers/${number.provider_sid}.json`,
        {},
        "DELETE"
      )
      await withImmediateTransaction(async (db) => {
        await db
          .prepare(
            "UPDATE sms_numbers SET state='released',membership_id=NULL,updated_at=? WHERE id=? AND workspace_id=?"
          )
          .run(nowIso(), input.numberId, c.workspace_id)
        await db
          .prepare(
            "UPDATE mca_sms_accounts SET state='revoked',updated_at=? WHERE id=? AND workspace_id=?"
          )
          .run(nowIso(), number.account_id, c.workspace_id)
      })
    }
    await getDatabase()
      .prepare(
        "UPDATE sms_operations SET state='complete',step=NULL,lease_until=NULL,error_code=NULL,updated_at=? WHERE id=?"
      )
      .run(nowIso(), id)
    await recordAuditEvent({
      context: { workspaceId: c.workspace_id, userId: null, source: "system" },
      action: `sms.${op.kind}_completed`,
      resourceType: "sms_operation",
      resourceId: id,
    })
  } catch (error) {
    // Every interrupted mutation is reconciled or reviewed, never blindly replayed.
    const current = await getDatabase()
      .prepare<{
        step: string | null
      }>("SELECT step FROM sms_operations WHERE id=?")
      .get(id)
    await getDatabase()
      .prepare(
        "UPDATE sms_operations SET state=?,error_code=?,lease_until=NULL,updated_at=? WHERE id=?"
      )
      .run(
        current?.step ? "needs_review" : "failed",
        error instanceof AppError ? error.code : "provider_outcome_unknown",
        nowIso(),
        id
      )
  }
}
export async function refreshCompany(
  workspaceId: string,
  api: TwilioApi = twilioApi
) {
  const c = await company(workspaceId)
  if (!c) return
  const campaignVerified = await registrationStatus(c, api)
  const current = await company(workspaceId)
  if (!current) return
  const p = provider(current)
  if (!p?.serviceSid) return
  const rows = await getDatabase()
    .prepare<{
      id: string
      provider_sid: string
      created_at: string
      state: string
    }>("SELECT id,provider_sid,created_at,state FROM sms_numbers WHERE workspace_id=? AND state IN ('registering','active','registration_failed')")
    .all(workspaceId)
  const configuredHours = Number(process.env.MCA_SMS_NUMBER_REG_ASSUME_HOURS)
  const hours = Number.isFinite(configuredHours) && configuredHours > 0 ? configuredHours : 6
  for (const n of rows) {
    const latest = await getDatabase().prepare<{ state: string }>("SELECT state FROM sms_registration_events WHERE workspace_id=? AND number_sid=? ORDER BY provider_time DESC,id DESC LIMIT 1").get(workspaceId, n.provider_sid)
    if (latest) {
      await getDatabase().prepare("UPDATE sms_numbers SET state=?,updated_at=? WHERE id=? AND state NOT IN ('released','releasing')").run(latest.state, nowIso(), n.id)
      continue
    }
    if (!campaignVerified || current.registration_state !== "approved" || n.state !== "registering" || Date.now() - Math.max(Date.parse(n.created_at), Date.parse(current.updated_at)) < hours * 3600000) continue
    await withImmediateTransaction(async (db) => {
      const number = await db.prepare<{ state: string }>("SELECT state FROM sms_numbers WHERE workspace_id=? AND id=? FOR UPDATE").get(workspaceId, n.id)
      if (number?.state !== "registering") return
      const failure = await db.prepare("SELECT id FROM sms_registration_events WHERE workspace_id=? AND number_sid=? AND state='registration_failed' LIMIT 1").get(workspaceId, n.provider_sid)
      if (failure) return
      const eventId = `assumed:${n.id}`
      const inserted = await db.prepare("INSERT INTO sms_registration_events (id,workspace_id,number_sid,state,provider_time,created_at) VALUES (?,?,?,'active',?,?) ON CONFLICT DO NOTHING RETURNING id").get(eventId, workspaceId, n.provider_sid, nowIso(), nowIso())
      if (!inserted) return
      await db.prepare("UPDATE sms_numbers SET state='active',updated_at=? WHERE workspace_id=? AND id=? AND state='registering'").run(nowIso(), workspaceId, n.id)
      await recordAuditEvent({ context: { workspaceId, userId: null, source: "system" }, action: "sms.number_registration_assumed", resourceType: "sms_number", resourceId: n.id, metadata: { hours }, executor: db })
    })
  }
}
export async function assignNumber(
  actor: DealActor,
  numberId: string,
  membershipId: string
) {
  admin(actor)
  return withImmediateTransaction(async (db) => {
    const n = await db
      .prepare<{
        account_id: string
      }>("SELECT account_id FROM sms_numbers WHERE workspace_id=? AND id=? AND state IN ('active','registering') FOR UPDATE")
      .get(actor.workspaceId, numberId)
    if (!n) throw new AppError(404, "number_missing", "Number not found.")
    if (
      !(await db
        .prepare(
          "SELECT id FROM memberships WHERE workspace_id=? AND id=? AND status='active'"
        )
        .get(actor.workspaceId, membershipId))
    )
      throw new AppError(422, "member_invalid", "Select an active employee.")
    if (
      await db
        .prepare(
          "SELECT id FROM sms_numbers WHERE workspace_id=? AND membership_id=? AND id<>? AND state<>'released'"
        )
        .get(actor.workspaceId, membershipId, numberId)
    )
      throw new AppError(
        409,
        "employee_has_number",
        "Employee already has a number."
      )
    await db
      .prepare(
        "UPDATE sms_numbers SET membership_id=?,updated_at=? WHERE id=? AND workspace_id=?"
      )
      .run(membershipId, nowIso(), numberId, actor.workspaceId)
    await db
      .prepare(
        "DELETE FROM mca_sms_account_members WHERE workspace_id=? AND account_id=?"
      )
      .run(actor.workspaceId, n.account_id)
    await db
      .prepare(
        "INSERT INTO mca_sms_account_members (workspace_id,account_id,membership_id,assigned_at,assigned_by_user_id) VALUES (?,?,?,?,?)"
      )
      .run(
        actor.workspaceId,
        n.account_id,
        membershipId,
        nowIso(),
        actor.userId
      )
    await db
      .prepare(
        "INSERT INTO sms_number_assignments (id,workspace_id,number_id,membership_id,actor_user_id,created_at) VALUES (?,?,?,?,?,?)"
      )
      .run(
        newId(),
        actor.workspaceId,
        numberId,
        membershipId,
        actor.userId,
        nowIso()
      )
    await recordAuditEvent({
      context: actor,
      action: "sms.number_assigned",
      resourceType: "sms_number",
      resourceId: numberId,
      metadata: { membershipId },
    })
    return { updated: true }
  })
}
