"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { Plus, Send, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { CHATKIT_DISCLAIMER, CHATKIT_START_PROMPTS, type ChatKitSurface } from "@/lib/mca/assistant/chatkit-ui"
import { decodeSse, messageText, type NativeChatRequest, type NativeChatEvent } from "@/lib/mca/assistant/native-contract"
import type { AssistantDeal } from "./chatkit-session"

type Item = Record<string, unknown>
type Page = { data: Item[]; after: string | null; has_more: boolean }

async function call(command: NativeChatRequest, signal?: AbortSignal, dealId?: string): Promise<Response> {
  const response = await fetch("/api/mca/chatkit", {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: { "content-type": "application/json", ...(dealId ? { "x-mca-deal-id": dealId } : {}) },
    body: JSON.stringify(command),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error?.message ?? "The assistant is unavailable.")
  }
  return response
}

export function NativeChat({
  deal,
  surface = "drawer",
  includedDealId,
  onIncludedDealChange,
  showIncludeToggle = true,
  initialThread = null,
  onThreadChange,
}: {
  deal: AssistantDeal
  surface?: ChatKitSurface
  includedDealId?: string | null
  onIncludedDealChange?: (id: string | null) => void
  showIncludeToggle?: boolean
  initialThread?: string | null
  onThreadChange?: (threadId: string | null) => void
}) {
  const [threads, setThreads] = useState<Item[]>([])
  const [threadId, setThreadId] = useState<string | null>(initialThread)
  const [threadCursor, setThreadCursor] = useState<string | null>(null)
  const [itemCursor, setItemCursor] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [text, setText] = useState("")
  const [title, setTitle] = useState("")
  const [includeDeal, setIncludeDeal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const turn = useRef<AbortController | null>(null)
  const read = useRef<AbortController | null>(null)
  const list = useRef<AbortController | null>(null)
  const pendingTurn = useRef<{ threadId: string | null; messageId: string; text: string } | null>(null)
  const end = useRef<HTMLDivElement | null>(null)
  const included = includedDealId !== undefined ? includedDealId === deal?.id : includeDeal
  const setIncluded = (value: boolean) => {
    if (onIncludedDealChange) onIncludedDealChange(value && deal ? deal.id : null)
    else setIncludeDeal(value)
  }
  const refresh = useCallback(async (after?: string) => {
    list.current?.abort()
    const controller = new AbortController()
    list.current = controller
    try {
      const page: Page = await (await call({ version: 1, type: "threads.list", params: { after } }, controller.signal)).json()
      if (controller.signal.aborted) return
      setThreads((old) => (after ? [...old, ...page.data] : page.data))
      setThreadCursor(page.after)
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message)
    }
  }, [])
  const bootThread = useRef(initialThread)
  const onThreadChangeRef = useRef(onThreadChange)
  const threadsRef = useRef(threads)
  useEffect(() => {
    onThreadChangeRef.current = onThreadChange
    threadsRef.current = threads
  })
  const load = useCallback(async (id: string, after?: string) => {
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    setLoading(true)
    setError(null)
    if (!after) {
      setThreadId(id)
      setItems([])
      setItemCursor(null)
      setTitle(String(threadsRef.current.find((thread) => thread.id === id)?.title ?? ""))
    }
    try {
      const page: Page = await (
        await call({ version: 1, type: "items.list", params: { thread_id: id, after } }, controller.signal)
      ).json()
      if (controller.signal.aborted) return
      const visible = page.data.filter((item) => ["user_message", "assistant_message"].includes(String(item.type))).reverse()
      setItems((old) => (after ? [...visible, ...old] : visible))
      setItemCursor(page.after)
      setThreadId(id)
      setTitle(String(threadsRef.current.find((thread) => thread.id === id)?.title ?? ""))
      pendingTurn.current = null
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const landing = bootThread.current
    if (landing) void load(landing)
    return () => {
      turn.current?.abort()
      read.current?.abort()
      list.current?.abort()
    }
  }, [refresh, load])
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" })
  }, [items])
  useEffect(() => {
    onThreadChangeRef.current?.(threadId)
  }, [threadId])

  function resetThread() {
    read.current?.abort()
    setThreadId(null)
    setItems([])
    setItemCursor(null)
    setError(null)
    setTitle("")
    pendingTurn.current = null
  }

  async function send(retry = false, preset?: string) {
    if (busy || loading) return
    const previous = pendingTurn.current
    const value = retry && previous ? previous.text : (preset ?? text).trim()
    if (!value) return
    const messageId = retry && previous ? previous.messageId : crypto.randomUUID()
    let currentThread = retry && previous ? previous.threadId : threadId
    const controller = new AbortController()
    turn.current = controller
    pendingTurn.current = { threadId: currentThread, messageId, text: value }
    setBusy(true)
    setError(null)
    setText("")
    const localId = `msg_${messageId}`,
      replyId = `reply_${messageId}`
    setItems((old) => [
      ...old.filter((item) => item.id !== localId && item.id !== replyId),
      { id: localId, type: "user_message", text: value, client_id: messageId },
    ])
    try {
      const response = await call(
        currentThread
          ? {
              version: 1,
              type: retry ? "threads.retry_after_item" : "threads.add_user_message",
              params: { thread_id: currentThread, message_id: messageId, text: value },
            }
          : { version: 1, type: "threads.create", params: { message_id: messageId, text: value } },
        controller.signal,
        included ? deal?.id : undefined
      )
      if (!response.body) throw new Error("The assistant returned an empty response.")
      let complete = false
      for await (const value of decodeSse(response.body)) {
        const event = value as NativeChatEvent
        if (controller.signal.aborted) break
        if (event.type === "start") {
          currentThread = event.threadId
          setThreadId(event.threadId)
          pendingTurn.current = { threadId: event.threadId, messageId, text: pendingTurn.current!.text }
          setItems((old) => [...old.filter((item) => item.id !== replyId), { id: replyId, type: "assistant_message", text: "" }])
        } else if (event.type === "delta")
          setItems((old) => old.map((item) => (item.id === replyId ? { ...item, text: messageText(item) + event.text } : item)))
        else if (event.type === "complete") complete = true
        else if (event.type === "error") throw new Error(event.message)
      }
      if (!complete && !controller.signal.aborted) throw new Error("The response was interrupted. Retry your question.")
      if (complete) {
        pendingTurn.current = null
        await refresh()
      }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message)
    } finally {
      setBusy(false)
      if (turn.current === controller) turn.current = null
    }
  }

  async function updateThread(remove = false) {
    if (!threadId || busy || loading) return
    setLoading(true)
    setError(null)
    try {
      await call(
        remove
          ? { version: 1, type: "threads.delete", params: { thread_id: threadId } }
          : { version: 1, type: "threads.update", params: { thread_id: threadId, title } }
      )
      if (remove) resetThread()
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const empty = !items.length
  const history = (
    <div className={cn("flex flex-col gap-2", surface === "page" ? "p-3" : "space-y-2 border-b p-3")}>
      <div className="flex gap-2">
        {surface === "drawer" && (
          <select
            aria-label="Conversation"
            disabled={busy || loading}
            value={threadId ?? ""}
            className="min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            onChange={(event) => {
              if (event.target.value) void load(event.target.value)
            }}
          >
            <option value="">New chat</option>
            {threads.map((thread) => (
              <option key={String(thread.id)} value={String(thread.id)}>
                {String(thread.title ?? "Conversation")}
              </option>
            ))}
          </select>
        )}
        <Button
          variant={surface === "page" ? "secondary" : "outline"}
          size="sm"
          className={surface === "page" ? "w-full justify-start" : undefined}
          disabled={busy || loading}
          onClick={resetThread}
        >
          <Plus className="size-4" />
          New chat
        </Button>
      </div>
      {surface === "page" && (
        <nav aria-label="Assistant chat history" className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {threads.map((thread) => (
            <Button
              key={String(thread.id)}
              variant={thread.id === threadId ? "secondary" : "ghost"}
              size="sm"
              className="w-full justify-start"
              onClick={() => void load(String(thread.id))}
            >
              <span className="truncate">{String(thread.title ?? "Conversation")}</span>
            </Button>
          ))}
        </nav>
      )}
      {threadCursor && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh(threadCursor)}>
          More conversations
        </Button>
      )}
      {threadId && surface === "drawer" && (
        <div className="flex gap-1">
          <Input aria-label="Conversation title" value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} />
          <Button size="sm" variant="outline" disabled={busy || loading || !title.trim()} onClick={() => void updateThread()}>
            Rename
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || loading} onClick={() => void updateThread(true)}>
            Delete
          </Button>
        </div>
      )}
    </div>
  )

  const composer = (
    <form
      className="space-y-2 border-t p-3"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      {showIncludeToggle && deal && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={included} disabled={busy} onChange={(event) => setIncluded(event.target.checked)} />
          Include {deal.label}
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-end gap-2 rounded-2xl border bg-background p-2 focus-within:ring-2 focus-within:ring-ring/30">
        <Textarea
          aria-label="Ask the assistant"
          placeholder="Ask about your deals…"
          value={text}
          maxLength={16000}
          disabled={busy || loading}
          rows={1}
          className="min-h-11 flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        {busy ? (
          <Button type="button" size="icon" variant="outline" aria-label="Stop response" onClick={() => turn.current?.abort()}>
            <Square className="size-4" />
          </Button>
        ) : (
          <Button type="submit" size="icon" disabled={loading || !text.trim()} aria-label="Send">
            <Send className="size-4" />
          </Button>
        )}
      </div>
      {!busy && pendingTurn.current && (
        <Button type="button" variant="outline" size="sm" onClick={() => void send(true)}>
          Retry question
        </Button>
      )}
      <p className="text-[11px] text-muted-foreground">{CHATKIT_DISCLAIMER}</p>
    </form>
  )

  const thread = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" role="log" aria-label="Assistant conversation" aria-live="polite">
        {itemCursor && threadId && (
          <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => void load(threadId, itemCursor)}>
            Earlier messages
          </Button>
        )}
        {empty && (
          <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-center">
            <h2 className="text-2xl font-medium tracking-tight">What would you like to know?</h2>
            <p className="max-w-md text-sm text-muted-foreground">{CHATKIT_DISCLAIMER}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {CHATKIT_START_PROMPTS.map((prompt) => (
                <Button
                  key={prompt.label}
                  variant="outline"
                  size="sm"
                  disabled={busy || loading}
                  onClick={() => void send(false, typeof prompt.prompt === "string" ? prompt.prompt : prompt.label)}
                >
                  {prompt.label}
                </Button>
              ))}
            </div>
          </div>
        )}
        {items.map((item) => {
          const user = item.type === "user_message"
          return (
            <article
              key={String(item.id)}
              className={cn("max-w-[80%] text-sm", user ? "ml-auto rounded-2xl bg-muted px-4 py-2" : "mr-auto space-y-1")}
            >
              {!user && <p className="text-xs font-medium text-muted-foreground">Assistant</p>}
              <div className="space-y-2 break-words">
                <ReactMarkdown>{messageText(item)}</ReactMarkdown>
              </div>
            </article>
          )
        })}
        <div ref={end} />
      </div>
      {composer}
    </div>
  )

  if (surface === "page") {
    return (
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 flex-col border-r lg:flex">{history}</aside>
        {thread}
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {history}
      {thread}
    </div>
  )
}
