import "server-only"

import { createHash } from "node:crypto"
import type { SmsDeliveryResult } from "../../contracts"
import {
  TEXTTORRENT_API_BASE,
  phonesMatch,
  texttorrentCreateChatUrl,
  texttorrentSendUrl,
  toReceiverNumber,
} from "./mapping"

export const TEXTTORRENT_FIXTURE_TRANSPORT = "fixture://texttorrent/messages"

export const SYNTHETIC_API_KEY = "SIDsynthetic0000000000000000000001"
export const SYNTHETIC_API_SECRET = "PKsynthetic-texttorrent-secret-never-leak"
export const EXPIRED_TEXTTORRENT_SECRET = "PKexpired-texttorrent-secret"

export const FIXTURE_SENDER = "+12125550999"
export const FIXTURE_RECIPIENT = "+12125550123"
export const FIXTURE_EXISTING_RECIPIENT = "+12125550124"
export const FIXTURE_REJECTED_NUMBER = "+15550000999"
export const FIXTURE_TIMEOUT_NUMBER = "+15550000998"
export const FIXTURE_BODY = "Exact synthetic TextTorrent preview"

export const FIXTURE_CHAT_ID = 1234
export const FIXTURE_EXISTING_CHAT_ID = 1235
export const FIXTURE_MESSAGE_ID = 5002

export const TEXTTORRENT_FIXTURE_CREDENTIALS = {
  apiKey: SYNTHETIC_API_KEY,
  apiSecret: SYNTHETIC_API_SECRET,
  sendingNumber: FIXTURE_SENDER,
}

export interface TextTorrentFixtureRecord {
  correlationId: string
  externalId: string
  completed: boolean
  timedOut: boolean
  failed: boolean
  sendCalls: number
  result?: SmsDeliveryResult
}

const records = new Map<string, TextTorrentFixtureRecord>()
const timedOutRecipients = new Set<string>()
let sendCallCount = 0

export function resetTextTorrentFixtures(): void {
  records.clear()
  timedOutRecipients.clear()
  sendCallCount = 0
}

export function peekTextTorrentFixture(correlationId: string): TextTorrentFixtureRecord | undefined {
  return records.get(correlationId)
}

export function texttorrentFixtureSendCallCount(): number {
  return sendCallCount
}

export function listTextTorrentFixtureExternalIds(): string[] {
  return [...new Set([...records.values()].filter((record) => record.completed).map((record) => record.externalId))]
}

export function texttorrentMessageId(correlationId: string): string {
  const hex = createHash("sha256").update(`texttorrent:${correlationId}`).digest("hex").slice(0, 12)
  const n = Number.parseInt(hex, 16) % 1_000_000_000
  return String(1000 + n)
}

export function fixtureCreateChatResponse(chatId = FIXTURE_CHAT_ID): { code: number; success: true; message: string; data: Record<string, unknown>; errors: null } {
  return {
    code: 201,
    success: true,
    message: "Chat started successfully.",
    data: {
      id: chatId,
      user_id: 1,
      contact_id: 568,
      from_number: FIXTURE_SENDER,
      last_message: null,
      created_at: "2026-09-08T12:00:00.000000Z",
      updated_at: "2026-09-08T12:00:00.000000Z",
    },
    errors: null,
  }
}

export function fixtureSendResponse(input: { id?: number; chatId?: number; status?: string } = {}): { code: number; success: true; message: string; data: Record<string, unknown>; errors: null } {
  return {
    code: 201,
    success: true,
    message: "Message send successfully",
    data: {
      id: input.id ?? FIXTURE_MESSAGE_ID,
      chat_id: input.chatId ?? FIXTURE_CHAT_ID,
      direction: "outbound",
      message: FIXTURE_BODY,
      msg_type: "sms",
      file: null,
      api_send_status: input.status ?? "sent",
      created_at: "2026-09-08T12:00:00.000000Z",
      updated_at: "2026-09-08T12:00:00.000000Z",
    },
    errors: null,
  }
}

export function fixtureRejectedSendResponse(): { code: number; success: false; message: string; data: null; errors: Record<string, string[]> } {
  return {
    code: 422,
    success: false,
    message: "Validation Error",
    data: null,
    errors: { to_number: ["The selected to number is invalid."] },
  }
}

export function fixtureAlreadyStartedResponse(): { code: number; success: false; message: string; data: null; errors: null } {
  return {
    code: 404,
    success: false,
    message: "You have already started a chat with this contact.",
    data: null,
    errors: null,
  }
}

export function fixtureInboxResponse(recipient: string, chatId: number): { code: number; success: true; message: string; data: { current_page: number; data: Array<Record<string, unknown>> }; errors: null } {
  return {
    code: 200,
    success: true,
    message: "Chats retrieved successfully",
    data: {
      current_page: 1,
      data: [{
        chat_id: chatId,
        user_id: 1,
        contact_id: 567,
        number: recipient,
        last_message: null,
        last_chat_time: "2026-09-08T12:00:00.000000Z",
      }],
    },
    errors: null,
  }
}

function recordFor(correlationId: string): TextTorrentFixtureRecord {
  const existing = records.get(correlationId)
  if (existing) return existing
  const created: TextTorrentFixtureRecord = {
    correlationId,
    externalId: texttorrentMessageId(correlationId),
    completed: false,
    timedOut: false,
    failed: false,
    sendCalls: 0,
  }
  records.set(correlationId, created)
  return created
}

export function rememberTextTorrentResult(correlationId: string, result: SmsDeliveryResult): TextTorrentFixtureRecord {
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

export function cachedTextTorrentResult(correlationId: string): SmsDeliveryResult | undefined {
  const record = records.get(correlationId)
  if (!record?.result) return undefined
  if (record.completed || record.failed || record.timedOut) return record.result
  return undefined
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
}

function unauthorized(): Response {
  return jsonResponse({ status: false, message: "Unauthorized", errors: [] }, 401)
}

function readForm(init?: RequestInit): Record<string, string> {
  const body = init?.body
  if (body instanceof FormData) {
    const record: Record<string, string> = {}
    body.forEach((value, key) => {
      if (typeof value === "string") record[key] = value
    })
    return record
  }
  return {}
}

function readJson(init?: RequestInit): Record<string, unknown> {
  return typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {}
}

function isAuthorized(init?: RequestInit): boolean {
  const headers = new Headers(init?.headers)
  const sid = headers.get("X-API-SID") ?? ""
  const secret = headers.get("X-API-PUBLIC-KEY") ?? ""
  if (!sid || !secret) return false
  if (secret === EXPIRED_TEXTTORRENT_SECRET) return false
  return sid === SYNTHETIC_API_KEY && secret === SYNTHETIC_API_SECRET
}

export async function texttorrentFixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), TEXTTORRENT_API_BASE)
  const method = (init?.method ?? "GET").toUpperCase()
  const href = `${url.origin}${url.pathname}`

  if (!isAuthorized(init)) return unauthorized()

  if (method === "POST" && href === texttorrentCreateChatUrl()) {
    const payload = readJson(init)
    const receiver = typeof payload.receiver_number === "string" ? payload.receiver_number : ""
    if (receiver === toReceiverNumber(FIXTURE_EXISTING_RECIPIENT)) return jsonResponse(fixtureAlreadyStartedResponse(), 404)
    const chatId = receiver === toReceiverNumber(FIXTURE_RECIPIENT) ? FIXTURE_CHAT_ID : FIXTURE_EXISTING_CHAT_ID
    return jsonResponse(fixtureCreateChatResponse(chatId), 201)
  }

  if (method === "GET" && href === `${TEXTTORRENT_API_BASE}/api/v1/inbox`) {
    const search = url.searchParams.get("search") ?? ""
    if (phonesMatch(search, FIXTURE_EXISTING_RECIPIENT) || toReceiverNumber(search) === toReceiverNumber(FIXTURE_EXISTING_RECIPIENT)) {
      return jsonResponse(fixtureInboxResponse(FIXTURE_EXISTING_RECIPIENT, FIXTURE_EXISTING_CHAT_ID), 200)
    }
    if (phonesMatch(search, FIXTURE_RECIPIENT) || toReceiverNumber(search) === toReceiverNumber(FIXTURE_RECIPIENT)) {
      return jsonResponse(fixtureInboxResponse(FIXTURE_RECIPIENT, FIXTURE_CHAT_ID), 200)
    }
    return jsonResponse({ code: 200, success: true, message: "Chats retrieved successfully", data: { current_page: 1, data: [] }, errors: null }, 200)
  }

  if (method === "POST" && href === texttorrentSendUrl()) {
    const form = readForm(init)
    const to = form.to_number ?? ""
    if (to === FIXTURE_TIMEOUT_NUMBER && !timedOutRecipients.has(to)) {
      timedOutRecipients.add(to)
      throw new TypeError("response lost")
    }
    if (to === FIXTURE_REJECTED_NUMBER) return jsonResponse(fixtureRejectedSendResponse(), 422)
    const chatId = Number(form.chat_id || FIXTURE_CHAT_ID) || FIXTURE_CHAT_ID
    const parsed = Number.parseInt(createHash("sha256").update(`texttorrent-send:${to}:${form.message ?? ""}`).digest("hex").slice(0, 8), 16)
    const id = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : FIXTURE_MESSAGE_ID
    return jsonResponse(fixtureSendResponse({ id, chatId, status: "sent" }), 201)
  }

  return new Response("not found", { status: 404 })
}
