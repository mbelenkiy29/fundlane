"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { decodeSse, messageText, type NativeChatRequest, type NativeChatEvent } from "@/lib/mca/assistant/native-contract"

type Item = Record<string, unknown>
type Page = { data: Item[]; after: string | null; has_more: boolean }
async function call(command: NativeChatRequest, signal?: AbortSignal, dealId?: string): Promise<Response> {
  const response = await fetch("/api/mca/chatkit", { method: "POST", credentials: "same-origin", signal,
    headers: { "content-type": "application/json", ...(dealId ? { "x-mca-deal-id": dealId } : {}) }, body: JSON.stringify(command) })
  if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error?.message ?? "The assistant is unavailable.") }
  return response
}

export function NativeChat({ deal }: { deal: { id: string; label: string } | null }) {
  const [threads, setThreads] = useState<Item[]>([]), [threadId, setThreadId] = useState<string | null>(null)
  const [threadCursor, setThreadCursor] = useState<string | null>(null), [itemCursor, setItemCursor] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([]), [text, setText] = useState(""), [title, setTitle] = useState("")
  const [includeDeal, setIncludeDeal] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const turn = useRef<AbortController | null>(null), read = useRef<AbortController | null>(null), list = useRef<AbortController | null>(null)
  const pendingTurn = useRef<{ threadId: string | null; messageId: string; text: string } | null>(null)
  const end = useRef<HTMLDivElement | null>(null)
  const refresh = useCallback(async (after?: string) => {
    list.current?.abort(); const controller = new AbortController(); list.current = controller
    try {
      const page: Page = await (await call({ version: 1, type: "threads.list", params: { after } }, controller.signal)).json()
      if (controller.signal.aborted) return
      setThreads(old => after ? [...old, ...page.data] : page.data); setThreadCursor(page.after)
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message) }
  }, [])
  useEffect(() => { void refresh(); return () => { turn.current?.abort(); read.current?.abort(); list.current?.abort() } }, [refresh])
  useEffect(() => { setIncludeDeal(false) }, [deal?.id])
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }) }, [items])

  async function load(id: string, after?: string) {
    read.current?.abort(); const controller = new AbortController(); read.current = controller
    setLoading(true); setError(null)
    if (!after) { setThreadId(id); setItems([]); setItemCursor(null); setTitle(String(threads.find(thread => thread.id === id)?.title ?? "")) }
    try {
      const page: Page = await (await call({ version: 1, type: "items.list", params: { thread_id: id, after } }, controller.signal)).json()
      if (controller.signal.aborted) return
      const visible = page.data.filter(item => ["user_message", "assistant_message"].includes(String(item.type))).reverse()
      setItems(old => after ? [...visible, ...old] : visible); setItemCursor(page.after); setThreadId(id)
      setTitle(String(threads.find(thread => thread.id === id)?.title ?? "")); pendingTurn.current = null
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }

  async function send(retry = false) {
    if (busy || loading) return
    const previous = pendingTurn.current
    const value = retry && previous ? previous.text : text.trim()
    if (!value) return
    const messageId = retry && previous ? previous.messageId : crypto.randomUUID()
    let currentThread = retry && previous ? previous.threadId : threadId
    const controller = new AbortController(); turn.current = controller
    pendingTurn.current = { threadId: currentThread, messageId, text: value }
    setBusy(true); setError(null); setText("")
    const localId = `msg_${messageId}`, replyId = `reply_${messageId}`
    setItems(old => [...old.filter(item => item.id !== localId && item.id !== replyId), { id: localId, type: "user_message", text: value, client_id: messageId }])
    try {
      const response = await call(currentThread
        ? { version: 1, type: retry ? "threads.retry_after_item" : "threads.add_user_message", params: { thread_id: currentThread, message_id: messageId, text: value } }
        : { version: 1, type: "threads.create", params: { message_id: messageId, text: value } }, controller.signal, includeDeal ? deal?.id : undefined)
      if (!response.body) throw new Error("The assistant returned an empty response.")
      let complete = false
      for await (const value of decodeSse(response.body)) {
        const event = value as NativeChatEvent
        if (controller.signal.aborted) break
        if (event.type === "start") {
          currentThread = event.threadId; setThreadId(event.threadId)
          pendingTurn.current = { threadId: event.threadId, messageId, text: pendingTurn.current!.text }
          setItems(old => [...old.filter(item => item.id !== replyId), { id: replyId, type: "assistant_message", text: "" }])
        } else if (event.type === "delta") setItems(old => old.map(item => item.id === replyId ? { ...item, text: messageText(item) + event.text } : item))
        else if (event.type === "complete") complete = true
        else if (event.type === "error") throw new Error(event.message)
      }
      if (!complete && !controller.signal.aborted) throw new Error("The response was interrupted. Retry your question.")
      if (complete) { pendingTurn.current = null; await refresh() }
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message) }
    finally { setBusy(false); if (turn.current === controller) turn.current = null }
  }

  async function updateThread(remove = false) {
    if (!threadId || busy || loading) return
    setLoading(true); setError(null)
    try {
      await call(remove ? { version: 1, type: "threads.delete", params: { thread_id: threadId } } : { version: 1, type: "threads.update", params: { thread_id: threadId, title } })
      if (remove) { setThreadId(null); setItems([]); setItemCursor(null); pendingTurn.current = null }
      await refresh()
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }

  return <div className="flex min-h-0 flex-1 flex-col bg-background">
    <div className="space-y-2 border-b p-3">
      <div className="flex gap-2"><select aria-label="Conversation" disabled={busy || loading} value={threadId ?? ""} className="min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" onChange={event => { if (event.target.value) void load(event.target.value) }}>
        <option value="">New chat</option>{threads.map(thread => <option key={String(thread.id)} value={String(thread.id)}>{String(thread.title ?? "Conversation")}</option>)}
      </select><Button variant="outline" size="sm" disabled={busy || loading} onClick={() => { read.current?.abort(); setThreadId(null); setItems([]); setItemCursor(null); setError(null); pendingTurn.current = null }}>New</Button></div>
      {threadCursor && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh(threadCursor)}>More conversations</Button>}
      {threadId && <div className="flex gap-1"><Input aria-label="Conversation title" value={title} maxLength={80} onChange={event => setTitle(event.target.value)} /><Button size="sm" variant="outline" disabled={busy || loading || !title.trim()} onClick={() => void updateThread()}>Rename</Button><Button size="sm" variant="ghost" disabled={busy || loading} onClick={() => void updateThread(true)}>Delete</Button></div>}
    </div>
    <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 space-y-4 overflow-y-auto p-4" role="log" aria-label="Assistant conversation" aria-live="polite">
      {itemCursor && threadId && <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => void load(threadId, itemCursor)}>Earlier messages</Button>}
      {!items.length && <div className="flex h-full flex-col items-center justify-center text-center"><p className="text-lg font-medium">What would you like to know?</p><p className="mt-2 text-sm text-muted-foreground">Ask about your deals, pipeline, or existing underwriting.</p></div>}
      {items.map(item => <article key={String(item.id)} className={`text-sm ${item.type === "user_message" ? "ml-auto max-w-[80%] rounded-3xl bg-muted px-4 py-3" : "w-full"}`}><div className="space-y-2 break-words"><ReactMarkdown>{messageText(item)}</ReactMarkdown></div></article>)}
      <div ref={end} />
    </div>
    <form className="mx-auto mb-3 w-full max-w-3xl space-y-2 rounded-3xl border bg-background p-3" onSubmit={event => { event.preventDefault(); void send() }}>
      {deal && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={includeDeal} disabled={busy} onChange={event => setIncludeDeal(event.target.checked)} />Include {deal.label}</label>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Textarea aria-label="Ask the assistant" placeholder="Ask about your pipeline…" value={text} maxLength={16000} disabled={busy || loading} className="min-h-16 resize-none border-0 shadow-none focus-visible:ring-0" onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
      <div className="flex justify-end gap-2">{!busy && pendingTurn.current && <Button type="button" variant="outline" onClick={() => void send(true)}>Retry question</Button>}{busy ? <Button type="button" variant="outline" onClick={() => turn.current?.abort()}>Stop response</Button> : <Button type="submit" disabled={loading || !text.trim()}>Send</Button>}</div>
    </form>
  </div>
}
