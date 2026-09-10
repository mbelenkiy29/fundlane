import "server-only"

import { createHash } from "node:crypto"
import type { SmsDeliveryResult } from "../../contracts"
import {
  ENTRANCE_API_BASE,
  entranceLoginUrl,
} from "./mapping"

export const ENTRANCE_FIXTURE_TRANSPORT = "fixture://entrance/messages"

export const SYNTHETIC_LOGIN_EMAIL = "entrance.operator@example.test"
export const SYNTHETIC_API_SECRET = "synthetic-entrance-api-secret-never-leak"
export const EXPIRED_ENTRANCE_SECRET = "expired-entrance-api-secret"

export const FIXTURE_WORKSPACE_ID = "3"
export const FIXTURE_USER_ID = "4065"
export const FIXTURE_CHANNEL_ID = 1028
export const FIXTURE_ACCESS_TOKEN = "synthetic-entrance-access-token"
export const FIXTURE_SENDER = "+12125550999"
export const FIXTURE_RECIPIENT = "+12125550123"
export const FIXTURE_REJECTED_NUMBER = "+15550000999"
export const FIXTURE_TIMEOUT_NUMBER = "+15550000998"
export const FIXTURE_BODY = "Exact synthetic preview"

export const FIXTURE_INBOUND_MESSAGE_ID = "89e392e0-39d3-4561-82b1-93b58007f717"
export const FIXTURE_INBOUND_FROM = "+15550000000"
export const FIXTURE_INBOUND_TO = "+15555550116"

export interface EntranceFixtureRecord {
  correlationId: string
  externalId: string
  completed: boolean
  timedOut: boolean
  failed: boolean
  sendCalls: number
  result?: SmsDeliveryResult
}

const records = new Map<string, EntranceFixtureRecord>()
const timedOutRecipients = new Set<string>()
let sendCallCount = 0

export function resetEntranceFixtures(): void {
  records.clear()
  timedOutRecipients.clear()
  sendCallCount = 0
}

export function peekEntranceFixture(correlationId: string): EntranceFixtureRecord | undefined {
  return records.get(correlationId)
}

export function entranceFixtureSendCallCount(): number {
  return sendCallCount
}

export function listEntranceFixtureExternalIds(): string[] {
  return [...new Set([...records.values()].filter((record) => record.completed).map((record) => record.externalId))]
}

export function entranceMessageId(correlationId: string): string {
  const hex = createHash("sha256").update(`entrance:${correlationId}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function fixtureLoginResponse(): { record: { access_token: string; workspace_id: string; user_id: string } } {
  return {
    record: {
      access_token: FIXTURE_ACCESS_TOKEN,
      workspace_id: FIXTURE_WORKSPACE_ID,
      user_id: FIXTURE_USER_ID,
    },
  }
}

export function fixtureRejectedSendResponse(): { code: string } {
  return { code: "invalid_number" }
}

/** Public-docs inbound SMS envelope from POST /receive-sms/receive. */
export function fixtureInboundPayload(text: string, overrides: { from?: string; id?: string } = {}): unknown {
  return {
    data: {
      payload: {
        direction: "inbound",
        encoding: "GSM-7",
        from: { carrier: "Verizon Wireless", line_type: "Wireless", phone_number: overrides.from ?? FIXTURE_INBOUND_FROM },
        id: overrides.id ?? FIXTURE_INBOUND_MESSAGE_ID,
        text,
        to: [{ carrier: "Telnyx", line_type: "Wireless", phone_number: FIXTURE_INBOUND_TO, status: "webhook_delivered" }],
        type: "SMS",
      },
    },
  }
}

function recordFor(correlationId: string): EntranceFixtureRecord {
  const existing = records.get(correlationId)
  if (existing) return existing
  const created: EntranceFixtureRecord = {
    correlationId,
    externalId: entranceMessageId(correlationId),
    completed: false,
    timedOut: false,
    failed: false,
    sendCalls: 0,
  }
  records.set(correlationId, created)
  return created
}

export function rememberEntranceResult(correlationId: string, result: SmsDeliveryResult): EntranceFixtureRecord {
  const record = recordFor(correlationId)
  record.result = result
  record.sendCalls += 1
  sendCallCount += 1
  if (result.state === "accepted" && result.externalId) {
    record.completed = true
    record.externalId = result.externalId
  }
  if (result.state === "failed") record.failed = true
  if (result.state === "unknown") record.timedOut = true
  return record
}

export function cachedEntranceResult(correlationId: string): SmsDeliveryResult | undefined {
  const record = records.get(correlationId)
  if (!record?.result) return undefined
  if (record.completed || record.failed) return record.result
  return undefined
}

export async function entranceFixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = (init?.method ?? "GET").toUpperCase()
  const rawBody = typeof init?.body === "string" ? init.body : ""
  const payload = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {}

  if (method === "POST" && url === entranceLoginUrl()) {
    const password = typeof payload.password === "string" ? payload.password : ""
    if (password === EXPIRED_ENTRANCE_SECRET || !password) {
      return new Response(JSON.stringify({ code: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify(fixtureLoginResponse()), { status: 200, headers: { "content-type": "application/json" } })
  }

  if (method === "POST" && url.startsWith(`${ENTRANCE_API_BASE}/workspaces/`) && url.endsWith("/messages")) {
    const number = typeof payload.number === "string" ? payload.number : ""
    if (number === FIXTURE_TIMEOUT_NUMBER && !timedOutRecipients.has(number)) {
      timedOutRecipients.add(number)
      throw new TypeError("response lost")
    }
    if (number === FIXTURE_REJECTED_NUMBER) {
      return new Response(JSON.stringify(fixtureRejectedSendResponse()), { status: 400, headers: { "content-type": "application/json" } })
    }
    const authorization = new Headers(init?.headers).get("authorization") ?? ""
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : ""
    if (!token) return new Response(JSON.stringify({ code: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })
    const id = createHash("sha256").update(`entrance-send:${token}:${number}:${typeof payload.message === "string" ? payload.message : ""}`).digest("hex")
    const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`
    return new Response(JSON.stringify({ record: { id: uuid, status: "queued" } }), { status: 200, headers: { "content-type": "application/json" } })
  }

  return new Response("not found", { status: 404 })
}


