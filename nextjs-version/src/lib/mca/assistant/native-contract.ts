import { z } from "zod"

const threadId = z.string().min(1).max(128)
const turn = z.object({ thread_id: threadId.optional(), message_id: z.string().uuid(), text: z.string().trim().min(1).max(16000) }).strict()
const existingTurn = turn.extend({ thread_id: threadId })
export const nativeChatRequest = z.discriminatedUnion("type", [
  z.object({ version: z.literal(1), type: z.literal("threads.create"), params: turn }).strict(),
  z.object({ version: z.literal(1), type: z.literal("threads.add_user_message"), params: existingTurn }).strict(),
  z.object({ version: z.literal(1), type: z.literal("threads.retry_after_item"), params: existingTurn }).strict(),
  z.object({ version: z.literal(1), type: z.literal("threads.list"), params: z.object({ after: threadId.optional() }).strict() }).strict(),
  z.object({ version: z.literal(1), type: z.literal("threads.get_by_id"), params: z.object({ thread_id: threadId }).strict() }).strict(),
  z.object({ version: z.literal(1), type: z.literal("items.list"), params: z.object({ thread_id: threadId, after: threadId.optional() }).strict() }).strict(),
  z.object({ version: z.literal(1), type: z.literal("threads.update"), params: z.object({ thread_id: threadId, title: z.string().trim().min(1).max(80) }).strict() }).strict(),
  z.object({ version: z.literal(1), type: z.literal("threads.delete"), params: z.object({ thread_id: threadId }).strict() }).strict(),
])
export type NativeChatRequest = z.infer<typeof nativeChatRequest>
export type NativeChatEvent =
  | { type: "start"; requestId: string; threadId: string; itemId: string }
  | { type: "delta"; text: string }
  | { type: "complete"; threadId: string; itemId: string }
  | { type: "error"; code: string; message: string }
  | {
      type: "draft"
      channel: "sms" | "email"
      dealId: string
      body: string
      merchantName?: string
      recipient?: string | null
      note?: string
    }

/** Reads both legacy ChatKit text blocks and the application-owned message format. */
export function messageText(item: Record<string, unknown>): string {
  if (typeof item.text === "string") return item.text
  if (!Array.isArray(item.content)) return ""
  return item.content.map(part => part && typeof part === "object" && typeof part.text === "string" ? part.text : "").join("\n")
}

/** Shared bounded SSE decoder; handles split UTF-8 and split frame delimiters. */
export async function* decodeSse(body: ReadableStream<Uint8Array>, maxFrameBytes = 256_000): AsyncGenerator<unknown> {
  const reader = body.getReader(), decoder = new TextDecoder()
  let pending = "", completed = false
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) { completed = true; break }
      pending += decoder.decode(chunk.value, { stream: true })
      pending = pending.replace(/\r\n/g, "\n")
      let boundary: number
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
        if (frame.length > maxFrameBytes) throw new Error("Stream event exceeds the size limit")
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
        if (data && data !== "[DONE]") yield JSON.parse(data)
      }
      if (pending.length > maxFrameBytes) throw new Error("Stream event exceeds the size limit")
    }
    pending += decoder.decode()
    if (pending.trim()) throw new Error("Stream ended with an incomplete event")
  } finally {
    if (!completed) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
