import "server-only"
import { createHash } from "node:crypto"
import { z } from "zod"
import { company, provider, publicOrigin } from "./onboarding"
import { withImmediateTransaction, nowIso } from "../db"
import { AppError } from "../errors"
import { validateTwilioFormSignature } from "./twilio"
const eventSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(100),
      type: z.string(),
      time: z.iso.datetime(),
      data: z.object({
        accountsid: z.string(),
        phonenumbersid: z.string(),
        messagingservicesid: z.string(),
        externalstatus: z.string(),
        updateddate: z.number().optional(),
      }),
    })
  )
  .max(1000)
export async function registrationEvents(
  workspaceId: string,
  request: Request
) {
  const c = await company(workspaceId),
    p = c ? provider(c) : undefined
  if (!p)
    throw new AppError(
      404,
      "company_missing",
      "Company registration not found."
    )
  const raw = await request.text()
  if (raw.length > 1000000)
    throw new AppError(413, "event_too_large", "Event payload too large.")
  const query = new URL(request.url).search,
    hash = new URL(request.url).searchParams.get("bodySHA256")
  if (
    !hash ||
    createHash("sha256").update(raw).digest("hex") !== hash ||
    !validateTwilioFormSignature({
      authToken: p.authToken,
      signature: request.headers.get("x-twilio-signature"),
      url: `${publicOrigin()}/api/mca/sms/webhooks/registration/${encodeURIComponent(workspaceId)}${query}`,
      params: new URLSearchParams(),
    })
  )
    throw new AppError(
      401,
      "twilio_signature_invalid",
      "Invalid event signature."
    )
  const parsed = eventSchema.safeParse(JSON.parse(raw))
  if (!parsed.success)
    throw new AppError(422, "event_invalid", "Invalid registration event.")
  await withImmediateTransaction(async (db) => {
    for (const event of parsed.data) {
      if (
        event.data.accountsid !== p.accountSid ||
        event.data.messagingservicesid !== p.serviceSid
      )
        throw new AppError(
          401,
          "event_account_mismatch",
          "Registration identity mismatch."
        )
      const states: Record<string, string> = {
        registered: "active",
        pending_registration: "registering",
        failure: "registration_failed",
        unregistered: "registering",
        pending_deregistration: "registering",
      }
      if (
        !event.type.startsWith(
          "com.twilio.messaging.compliance.number-registration."
        ) ||
        !states[event.data.externalstatus]
      )
        continue
      const time = event.data.updateddate
        ? new Date(event.data.updateddate).toISOString()
        : event.time
      const inserted = await db
        .prepare(
          "INSERT INTO sms_registration_events (id,workspace_id,number_sid,state,provider_time,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id"
        )
        .get(
          event.id,
          workspaceId,
          event.data.phonenumbersid,
          states[event.data.externalstatus],
          time,
          nowIso()
        )
      if (inserted) {
        const latest = await db
          .prepare<{
            state: string
          }>("SELECT state FROM sms_registration_events WHERE workspace_id=? AND number_sid=? ORDER BY provider_time DESC,id DESC LIMIT 1")
          .get(workspaceId, event.data.phonenumbersid)
        await db
          .prepare(
            "UPDATE sms_numbers SET state=?,updated_at=? WHERE workspace_id=? AND provider_sid=? AND state NOT IN ('released','releasing')"
          )
          .run(latest!.state, nowIso(), workspaceId, event.data.phonenumbersid)
      }
    }
  })
  return { received: true }
}
