import "server-only"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { assertTrustedMutation, consumeRequestRateLimit, requireMembershipAccess } from "../auth"
import { getDatabase, withImmediateTransaction } from "../db"
import { AppError, apiError } from "../errors"
import { getDeal } from "../deals/service"
import { assistantContext } from "./chatkit-context"
import { boundedBody, bodyHash, requireAssistant, requireAssistantConfigured, signDelegation } from "./security"
import { ownedThread } from "./store"
import { nativeAssistant } from "./native-runtime"

export const chatRequest = z.object({
  type: z.enum(["threads.create", "threads.add_user_message", "threads.retry_after_item", "threads.get_by_id", "threads.list", "threads.update", "threads.delete", "items.list"]),
  params: z.object({ thread_id: z.string().min(1).max(128).optional() }).passthrough(),
}).passthrough()
const turns = new Set(["threads.create", "threads.add_user_message", "threads.retry_after_item"])
export async function chatkitGateway(request: Request, authenticate = requireMembershipAccess) {
  const requestId = randomUUID(), started = Date.now()
  let registered = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = new AbortController()
  const onAbort = () => { abort.abort(); void finish() }
  let cleanup: Promise<void> | undefined
  const finish = () => cleanup ??= (async () => {
    if (timer) clearTimeout(timer)
    request.signal.removeEventListener("abort", onAbort)
    if (registered) { registered = false; await getDatabase().prepare("DELETE FROM mca_chatkit_requests WHERE id=?").run(requestId) }
  })()
  try {
    requireAssistantConfigured(); assertTrustedMutation(request)
    const context = await authenticate(request)
    requireAssistant(context)
    const c = await assistantContext(context)
    const raw = await boundedBody(request)
    let parsed: z.infer<typeof chatRequest>
    try { parsed = chatRequest.parse(JSON.parse(raw)) } catch { throw new AppError(400, "invalid_chatkit_request", "Unsupported assistant request.") }
    const isTurn = turns.has(parsed.type)
    if (parsed.type !== "threads.create" && parsed.type !== "threads.list" && !parsed.params.thread_id) throw new AppError(400, "thread_required", "Choose a conversation.")
    if (parsed.params.thread_id) await ownedThread(c, parsed.params.thread_id, parsed.type !== "threads.delete")
    const contextDealId = isTurn ? request.headers.get("x-mca-deal-id") || undefined : undefined
    if (contextDealId) { if (contextDealId.length > 128) throw new AppError(400, "invalid_deal", "Invalid deal."); await getDeal(c.actor, contextDealId) }
    await consumeRequestRateLimit(`chatkit:${c.context.workspaceId}:${c.context.userId}:${isTurn ? "turn" : "read"}`, isTurn ? 10 : 120)
    const native = process.env.MCA_ASSISTANT_RUNTIME === "vercel_node"
    const serviceUrl = process.env.MCA_ASSISTANT_SERVICE_URL
    if ((!native && !serviceUrl) || !c.context.sessionId) throw new AppError(503, "assistant_unconfigured", "The assistant is not configured.")
    const now = Math.floor(Date.now() / 1000)
    const token = signDelegation({ aud: "mca-chatkit", requestId, userId: c.context.userId, workspaceId: c.context.workspaceId,
      membershipId: c.context.membershipId, sessionId: c.context.sessionId, bodyHash: bodyHash(raw), contextDealId, iat: now, exp: now + 120 })
    await withImmediateTransaction(async db => {
      await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`chatkit:${c.context.workspaceId}:${c.context.userId}`)
      await db.prepare("DELETE FROM mca_chatkit_requests WHERE expires_at<=?").run(new Date().toISOString())
      if (isTurn && await db.prepare("SELECT id FROM mca_chatkit_requests WHERE workspace_id=? AND user_id=? AND is_turn=1")
        .get(c.context.workspaceId, c.context.userId)) throw new AppError(409, "assistant_busy", "Wait for the current response or stop it before sending another.")
      await db.prepare("INSERT INTO mca_chatkit_requests(id,workspace_id,user_id,expires_at,is_turn) VALUES(?,?,?,?,?)")
        .run(requestId, c.context.workspaceId, c.context.userId, new Date((now + 120) * 1000).toISOString(), isTurn ? 1 : 0)
    })
    registered = true
    request.signal.addEventListener("abort", onAbort, { once: true })
    if (request.signal.aborted) abort.abort()
    timer = setTimeout(onAbort, 120_000)
    const upstream = native
      ? await nativeAssistant(new Request(request.url, { method: "POST", body: raw,
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, signal: abort.signal }))
      : await fetch(new URL("/chatkit", serviceUrl!.includes("://") ? serviceUrl! : `http://${serviceUrl}${serviceUrl!.includes(":") ? "" : ":8000"}`), {
          method: "POST", body: raw, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, signal: abort.signal, redirect: "error",
        })
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel()
      throw new AppError(upstream.status === 429 ? 429 : 502, "assistant_unavailable", "The assistant could not respond. Please retry.")
    }
    const reader = upstream.body.getReader()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read()
          if (chunk.done) {
            await finish(); controller.close()
            console.info(JSON.stringify({ event: "assistant.complete", requestId, durationMs: Date.now() - started }))
          } else controller.enqueue(chunk.value)
        } catch {
          abort.abort(); await finish(); controller.error(new Error("Assistant connection interrupted."))
          console.info(JSON.stringify({ event: "assistant.error", requestId, category: "stream_interrupted" }))
        }
      },
      async cancel() { abort.abort(); await reader.cancel().catch(() => {}); await finish() },
    })
    return new Response(stream, { headers: { "content-type": upstream.headers.get("content-type")?.includes("text/event-stream") ? "text/event-stream" : "application/json",
      "cache-control": "private, no-store", "x-accel-buffering": "no", "x-request-id": requestId } })
  } catch (error) {
    abort.abort(); await finish()
    console.info(JSON.stringify({ event: "assistant.error", requestId, category: error instanceof AppError ? error.code : "service_failure" }))
    return apiError(error instanceof AppError ? error : new AppError(502, "assistant_unavailable", "The assistant is unavailable. Please retry."), requestId)
  }
}
