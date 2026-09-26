import "server-only"
import {
  getDatabase,
  nowIso,
  withImmediateTransaction,
  recordAuditEvent,
} from "../db"
import { company, provider, type Company, operator } from "./onboarding"
import {
  runProvisioning,
  refreshCompany,
  twilioApi,
  type TwilioApi,
} from "./provisioning"
import { decryptSensitive, encryptSensitive } from "../crypto"
import { AppError } from "../errors"
import type { AuthContext } from "../types"
import { executionShouldStop } from "../jobs/execution"
export async function reconcileUsage(
  workspaceId: string,
  api: TwilioApi = twilioApi
) {
  const c = await company(workspaceId),
    p = c ? provider(c) : undefined
  if (!p) return
  const period = nowIso().slice(0, 7),
    result = await api(
      p,
      "api",
      `/2010-04-01/Accounts/${p.accountSid}/Usage/Records/ThisMonth.json?PageSize=1000`
    )
  const rows = (result.usage_records ?? []) as {
    category: string
    price: string
    price_unit: string
    count: string
  }[]
  await withImmediateTransaction(async (db) => {
    const numbers = await db
      .prepare<{
        id: string
        monthly_cents: number
      }>("SELECT id,monthly_cents FROM sms_numbers WHERE workspace_id=? AND state<>'released'")
      .all(workspaceId)
    for (const n of numbers) {
      if (await db.prepare("SELECT id FROM sms_usage WHERE id=? AND period=?").get(n.id,period)) continue
      await db
        .prepare(
          "INSERT INTO sms_usage (id,workspace_id,period,category,estimated_cents,updated_at) VALUES (?,?,?,'number_rental',?,?) ON CONFLICT DO NOTHING"
        )
        .run(
          `rental:${n.id}:${period}`,
          workspaceId,
          period,
          n.monthly_cents,
          nowIso()
        )
    }
    for (const r of rows) {
      if (
        r.price_unit.toLowerCase() !== "usd" ||
        !Number.isFinite(Number(r.price))
      )
        continue
      const category =
        r.category === "totalprice"
          ? "provider_total"
          : `provider:${r.category}`
      await db
        .prepare(
          "INSERT INTO sms_usage (id,workspace_id,period,category,actual_cents,quantity,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET actual_cents=EXCLUDED.actual_cents,quantity=EXCLUDED.quantity,updated_at=EXCLUDED.updated_at"
        )
        .run(
          `twilio:${workspaceId}:${period}:${r.category}`,
          workspaceId,
          period,
          category,
          Math.ceil(Math.abs(Number(r.price)) * 100),
          r.count,
          nowIso()
        )
    }
  })
}
export async function maintenance(
  api: TwilioApi = twilioApi,
  limits: { operations?: number; companies?: number } = {}
) {
  const operationLimit = limits.operations ?? 10
  const companyLimit = limits.companies ?? 100
  const ops = await getDatabase()
    .prepare<{
      id: string
    }>("SELECT id FROM sms_operations WHERE state IN ('queued','running') ORDER BY updated_at LIMIT ?")
    .all(operationLimit)
  let operations = 0
  for (const op of ops) {
    if (executionShouldStop()) break
    await runProvisioning(op.id, api)
    operations++
  }
  const companies = await getDatabase()
    .prepare<Company>(
      "SELECT * FROM sms_companies WHERE provider_cipher IS NOT NULL ORDER BY updated_at LIMIT ?"
    )
    .all(companyLimit)
  const errors: string[] = []
  let companiesProcessed = 0
  for (const c of companies) {
    if (executionShouldStop()) break
    companiesProcessed++
    try {
      await refreshCompany(c.workspace_id, api)
      await reconcileUsage(c.workspace_id, api)
    } catch {
      errors.push(c.workspace_id)
    }
  }
  return {
    operations,
    companies: companiesProcessed,
    failedWorkspaces: errors,
  }
}
export async function usageRows(workspaceId: string) {
  return {
    usage: await getDatabase()
      .prepare(
        "SELECT period,category,estimated_cents,actual_cents,quantity,updated_at FROM sms_usage WHERE workspace_id=? ORDER BY period DESC,category LIMIT 1000"
      )
      .all(workspaceId),
    notice:
      "Provider category rows overlap; use provider_total for the actual total. Estimates are reservations, not the invoice.",
  }
}
// Recovery never asks the browser to provide provider secrets. Read-only remote lookup
// verifies the deterministic identity before an interrupted purchase/account creation resumes.
export async function reconcileOperation(
  context: AuthContext,
  id: string,
  api: TwilioApi = twilioApi
) {
  operator(context)
  const op = await getDatabase()
    .prepare<{
      workspace_id: string
      state: string
      step: string
      result_cipher: string | null
      payload_cipher: string
    }>("SELECT * FROM sms_operations WHERE id=?")
    .get(id)
  if (!op || op.state !== "needs_review")
    throw new AppError(
      409,
      "operation_not_reviewable",
      "This operation does not need reconciliation."
    )
  const c = (await company(op.workspace_id))!,
    p = provider(c),
    results = op.result_cipher
      ? JSON.parse(decryptSensitive(op.result_cipher, op.workspace_id))
      : {}
  const input = JSON.parse(decryptSensitive(op.payload_cipher, op.workspace_id))
  let recovered: Record<string, unknown> | undefined
  if (op.step === "purchase" && p) {
    const response = await api(
      p,
      "api",
      `/2010-04-01/Accounts/${p.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(input.phone)}`
    )
    const matches = (
      (response.incoming_phone_numbers ?? []) as Record<string, unknown>[]
    ).filter(
      (n) =>
        n.friendly_name === `Fundlane ${id}` && n.phone_number === input.phone
    )
    if (matches.length === 1) recovered = matches[0]
  }
  if (op.step === "subaccount") {
    const response = await api(
      null,
      "api",
      `/2010-04-01/Accounts.json?FriendlyName=${encodeURIComponent(`Fundlane ${op.workspace_id}`)}`
    )
    const matches = (
      (response.accounts ?? []) as Record<string, unknown>[]
    ).filter((n) => n.friendly_name === `Fundlane ${op.workspace_id}`)
    if (matches.length === 1)
      recovered = await api(
        null,
        "api",
        `/2010-04-01/Accounts/${String(matches[0].sid)}.json`
      )
  }
  if (op.step === "attach" && p && results.purchase?.sid) {
    try {
      recovered=await api(p,"messaging",`/v1/Services/${p.serviceSid}/PhoneNumbers/${String(results.purchase.sid)}`)
    } catch(error) {
      // A definitive 404 proves this non-purchasing attachment can be retried.
      if (!(error instanceof AppError) || error.code !== "twilio_20404") throw error
      await getDatabase().prepare("UPDATE sms_operations SET state='queued',step=NULL,error_code=NULL,updated_at=? WHERE id=? AND state='needs_review'").run(nowIso(),id)
      await recordAuditEvent({context:{workspaceId:op.workspace_id,userId:context.userId},action:"sms.attachment_retry_authorized",resourceType:"sms_operation",resourceId:id})
      return {reconciled:true}
    }
  }
  if (!recovered)
    throw new AppError(
      409,
      "manual_provider_review_required",
      "The remote outcome could not be uniquely verified. Inspect the provider operation before any retry; no second resource was created."
    )
  results[op.step] = recovered
  await getDatabase()
    .prepare(
      "UPDATE sms_operations SET result_cipher=?,state='queued',step=NULL,error_code=NULL,updated_at=? WHERE id=? AND state='needs_review'"
    )
    .run(
      encryptSensitive(JSON.stringify(results), op.workspace_id),
      nowIso(),
      id
    )
  await recordAuditEvent({
    context: { workspaceId: op.workspace_id, userId: context.userId },
    action: "sms.operation_reconciled",
    resourceType: "sms_operation",
    resourceId: id,
  })
  return { reconciled: true }
}
