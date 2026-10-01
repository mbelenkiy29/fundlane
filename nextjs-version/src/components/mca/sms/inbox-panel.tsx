"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { RequestError, requestJson } from "@/lib/mca/client"
import { editSmsReplyDraft, reserveSmsReplyDraft, settleSmsReplyDraft, rejectSmsReplyDraft, postSmsReplyAndRefresh, type SmsReplyDraft } from "@/lib/mca/sms/reply-draft"
import { refreshSmsConversation } from "@/lib/mca/sms/inbox-refresh"
type Thread = {
  id: string
  accountId: string
  dealId: string | null
  recipient: string
  unread: number
}
type Detail = {
  id: string
  accountId: string
  dealId: string | null
  recipient: string
  messages: {
    id: string
    direction: string
    body: string
    state: string
    createdAt: string
    error?: string | null
  }[]
}
export function SmsInboxPanel({ dealId }: { dealId?: string }) {
  const [threads, setThreads] = useState<Thread[]>([]),
    [selected, setSelected] = useState<string>(),
    [detail, setDetail] = useState<Detail>(),
    [draft, setDraft] = useState<SmsReplyDraft>({ body: "" }),
    [failedAttempt, setFailedAttempt] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [associate, setAssociate] = useState(""),
    [preview, setPreview] = useState<{
      canSend: boolean
      block?: { message: string }
    }>()
  const selectedRef = useRef<string | undefined>(undefined)
  const requestSequence = useRef(0)
  const listSequence = useRef(0)
  const drafts = useRef(new Map<string, SmsReplyDraft>())
  const failures = useRef(new Set<string>())
  const attempts = useRef(new Map<string, string>())
  const body = draft.body
  const load = useCallback(async () => {
    const sequence = ++listSequence.current
    const result = await requestJson<{ conversations: Thread[] }>(
      `/api/mca/sms/conversations${dealId ? `?dealId=${encodeURIComponent(dealId)}` : ""}`
    )
    if (sequence === listSequence.current) setThreads(result.conversations)
  }, [dealId])
  const open = useCallback(
    async (id: string) => {
      const sequence = ++requestSequence.current
      await refreshSmsConversation({
        read: () => requestJson<Detail>(`/api/mca/sms/conversations?id=${encodeURIComponent(id)}`),
        isCurrent: () => selectedRef.current === id && sequence === requestSequence.current,
        show: (d) => {
          setDetail(d)
          const attemptId = attempts.current.get(id)
          const outcome = d.messages.find(m => m.id === attemptId)?.state
          if (outcome && drafts.current.get(id)?.idempotencyKey) {
            const next = settleSmsReplyDraft(drafts.current.get(id)!, outcome)
            drafts.current.set(id, next)
            setDraft(next)
            if (!next.idempotencyKey) { attempts.current.delete(id); failures.current.delete(id); setFailedAttempt(false); setPreview(undefined) }
            if (outcome === "failed") { failures.current.add(id); setFailedAttempt(true) }
          }
        },
        acknowledge: () => requestJson("/api/mca/sms/conversations", {
          method: "POST",
          body: JSON.stringify({ id }),
        }),
        refreshList: load,
      })
    },
    [load]
  )
  useEffect(() => {
    selectedRef.current = undefined
    requestSequence.current++
    listSequence.current++
    setSelected(undefined)
    setDetail(undefined)
    setThreads([])
    setDraft({ body: "" })
    setPreview(undefined)
    setFailedAttempt(false)
    setError("")
    void load().catch((e) => setError(e.message))
  }, [load])
  useEffect(() => {
    if (!selected) return
    let stopped = false
    const refresh = () => {
      if (!stopped) void open(selected).catch((e) => { if (!stopped && selectedRef.current === selected) setError(e.message) })
    }
    refresh()
    const timer = setInterval(refresh, 15000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [selected, open])
  async function send(isPreview: boolean) {
    if (!detail?.dealId) return
    setBusy(true)
    setError("")
    const target = detail
    const reserved = isPreview ? draft : reserveSmsReplyDraft(draft, crypto.randomUUID())
    const key = reserved.idempotencyKey ?? crypto.randomUUID()
    if (!isPreview) { setDraft(reserved); drafts.current.set(target.id, reserved) }
    try {
      await postSmsReplyAndRefresh({
        post: () => requestJson<{
          canSend: boolean
          block?: { message: string }
          state?: string
          messageId?: string
          errorMessage?: string
        }>("/api/mca/sms/messages", {
          method: "POST",
          body: JSON.stringify({
            dealId: target.dealId,
            conversationId: target.id,
            recipient: target.recipient,
            body: reserved.body,
            senderAccountId: target.accountId,
            idempotencyKey: key,
            preview: isPreview,
          }),
        }),
        onResult: (result) => {
          if (selectedRef.current !== target.id) return false
          if (isPreview) { setPreview(result); return false }
          if (result.messageId) attempts.current.set(target.id, result.messageId)
          const next = settleSmsReplyDraft(reserved, result.state)
          drafts.current.set(target.id, next)
          setDraft(next)
          if (result.state === "failed") { failures.current.add(target.id); setFailedAttempt(true) }
          if (result.state !== "accepted")
            setError(
              result.errorMessage ??
                "Provider outcome is unknown. Refresh delivery status before sending again."
            )
          else {
            attempts.current.delete(target.id)
            failures.current.delete(target.id)
            setFailedAttempt(false)
            setPreview(undefined)
          }
          return true
        },
        onPostError: (e) => {
          if (!isPreview && e instanceof RequestError) {
            const next = rejectSmsReplyDraft(reserved, e.code, !!draft.idempotencyKey)
            drafts.current.set(target.id, next)
            setDraft(next)
            if (!next.idempotencyKey) setPreview(undefined)
          }
          setError(e instanceof Error ? e.message : "Message failed")
        },
        refresh: () => open(target.id),
        onRefreshError: (e) => setError(`Conversation refresh failed: ${e instanceof Error ? e.message : "Unknown error"}`),
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">SMS inbox</h2>
        <Button
          variant="outline"
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="grid min-h-96 overflow-hidden rounded-lg border md:grid-cols-[260px_1fr]">
        <aside className="border-r bg-muted/20 p-3">
          <p className="mb-3 text-xs text-muted-foreground">
            Company SMS and authorized deals
          </p>
          {!threads.length && (
            <p className="text-sm">
              No conversations yet. Start a text from a deal’s Messages tab.
            </p>
          )}
          {threads.map((t) => (
            <button
              key={t.id}
              className={`mb-2 w-full rounded p-3 text-left ${selected === t.id ? "bg-muted" : "hover:bg-muted/50"}`}
              disabled={busy}
              onClick={() => {
                selectedRef.current = t.id
                requestSequence.current++
                setSelected(t.id)
                setDetail(undefined)
                setError("")
                setDraft(drafts.current.get(t.id) ?? { body: "" })
                setFailedAttempt(failures.current.has(t.id))
                setPreview(undefined)
              }}
            >
              <span className="font-medium">{t.recipient}</span>
              {t.unread > 0 && (
                <span className="ml-2 rounded bg-primary px-2 text-primary-foreground">
                  {t.unread}
                </span>
              )}
              <span className="block text-xs text-muted-foreground">
                {t.dealId
                  ? "Application conversation"
                  : "Needs deal association"}
              </span>
            </button>
          ))}
        </aside>
        <div className="space-y-4 p-4">
          {!detail ? (
            <p className="text-muted-foreground">
              Select a conversation to view messages.
            </p>
          ) : (
            <>
              <h3 className="font-medium">{detail.recipient}</h3>
              <div className="max-h-[480px] space-y-3 overflow-y-auto">
                {detail.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`max-w-[85%] rounded-lg p-3 ${m.direction === "outbound" ? "ml-auto bg-primary/10" : "bg-muted"}`}
                  >
                    <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {m.direction === "outbound" ? "Sent" : "Received"} ·{" "}
                      {new Date(m.createdAt).toLocaleString()} · {m.state}
                    </p>
                    {m.error && (
                      <p className="text-xs text-destructive">{m.error}</p>
                    )}
                  </div>
                ))}
              </div>
              {detail.dealId ? (
                <div className="space-y-3">
                  <Textarea
                    aria-label="SMS reply"
                    value={body}
                    maxLength={1600}
                    disabled={busy || !!draft.idempotencyKey}
                    onChange={(e) => {
                      const next = editSmsReplyDraft(draft, e.target.value)
                      setDraft(next)
                      drafts.current.set(detail.id, next)
                      setPreview(undefined)
                    }}
                    placeholder="Reply about the requested application…"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={busy || !body.trim()}
                      onClick={() => void send(true)}
                    >
                      Preview and check consent
                    </Button>
                    <Button
                      disabled={busy || !preview?.canSend}
                      onClick={() => void send(false)}
                    >
                      Send reply
                    </Button>
                  </div>
                  {draft.idempotencyKey && <p role="status" className="text-sm text-muted-foreground">
                    This attempt retains its exact text and retry key. Refresh or check the message status before starting another send.
                  </p>}
                  {failedAttempt && <Button variant="outline" disabled={busy} onClick={() => {
                    const next = { body: draft.body }
                    setDraft(next)
                    drafts.current.set(detail.id, next)
                    attempts.current.delete(detail.id)
                    failures.current.delete(detail.id)
                    setFailedAttempt(false)
                    setPreview(undefined)
                  }}>Start a new draft after rejection</Button>}
                  {preview?.block && (
                    <p role="status" className="text-sm">
                      {preview.block.message} Manage consent in the deal’s
                      Messages tab.
                    </p>
                  )}
                  {preview?.canSend && (
                    <p className="text-sm text-muted-foreground">
                      Sending to {detail.recipient}. Current consent and number
                      availability will be checked again.
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm">
                    An administrator must associate this reply with a matching
                    deal before messaging. Ambiguous replies are never assigned
                    automatically.
                  </p>
                  <Input
                    aria-label="Matching deal ID"
                    placeholder="Matching deal ID"
                    value={associate}
                    onChange={(e) => setAssociate(e.target.value)}
                  />
                  <Button
                    disabled={busy || !associate}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        await requestJson("/api/mca/sms/conversations", {
                          method: "POST",
                          body: JSON.stringify({
                            id: detail.id,
                            dealId: associate,
                          }),
                        })
                        await open(detail.id)
                      } catch (e) {
                        setError(
                          e instanceof Error ? e.message : "Association failed"
                        )
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Associate deal
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
