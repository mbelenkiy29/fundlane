"use client"
import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { Mail, Plus, RefreshCw, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { requestJson } from "@/lib/mca/client"
import type { EmailSender } from "@/lib/mca/senders/contracts"
import type {
  ConversationPage,
  MessagePage,
  ConversationSummary,
} from "@/lib/mca/email-conversations/contracts"
import { PersonalEmailConnections } from "./connections"

type ComposerContext = {
  dealId: string
  recipient: string | null
  senders: EmailSender[]
}
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Unable to load email. Please try again."
const pendingStates = new Set([
  "queued",
  "sending",
  "accepted",
  "unknown",
  "blocked",
])
export function EmailInbox({
  dealId,
  showConnections = false,
}: {
  dealId?: string
  showConnections?: boolean
}) {
  const [threads, setThreads] = useState<ConversationSummary[]>([]),
    [next, setNext] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<MessagePage>(),
    [context, setContext] = useState<ComposerContext>(),
    [composeDeal, setComposeDeal] = useState(dealId ?? "")
  const [isNew, setIsNew] = useState(Boolean(dealId)),
    [body, setBody] = useState(""),
    [subject, setSubject] = useState(""),
    [senderId, setSenderId] = useState("")
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("")
  const [query, setQuery] = useState(""),
    [deals, setDeals] = useState<
      { id: string; legalName: string; displayId: string }[]
    >([])
  const sendKey = useRef<string | null>(null),
    selection = useRef(selected),
    draftStore = useRef(
      new Map<
        string,
        { body: string; subject: string; senderId: string; key: string | null }
      >()
    )
  selection.current = selected
  const draftId = isNew ? `new:${composeDeal}` : `reply:${selected}`
  const load = useCallback(
    async (cursor?: string) => {
      const q = new URLSearchParams()
      if (dealId) q.set("dealId", dealId)
      if (cursor) q.set("cursor", cursor)
      const page = await requestJson<ConversationPage>(
        `/api/mca/email/conversations?${q}`
      )
      setThreads((old) =>
        cursor
          ? [
              ...old,
              ...page.conversations.filter(
                (row) => !old.some((o) => o.id === row.id)
              ),
            ]
          : page.conversations
      )
      setNext(page.nextCursor)
      setLoading(false)
    },
    [dealId]
  )
  const open = useCallback(async (id: string) => {
    const page = await requestJson<MessagePage>(
      `/api/mca/email/conversations/${id}`
    )
    if (selection.current !== id) return
    setDetail((current) =>
      current?.conversation.id === id && current.messages.length > 50
        ? {
            ...page,
            messages: [
              ...current.messages.filter(
                (m) => !page.messages.some((n) => n.id === m.id)
              ),
              ...page.messages,
            ],
            nextCursor: current.nextCursor,
          }
        : page
    )
    const sequence = page.messages.at(-1)?.sequence
    if (sequence)
      await requestJson(`/api/mca/email/conversations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ sequence }),
      })
    setThreads((old) => old.map((t) => (t.id === id ? { ...t, unread: 0 } : t)))
  }, [])
  useEffect(() => {
    let active = true
    void load().catch((e) => {
      if (active) {
        setError(errorText(e))
        setLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [load])
  useEffect(() => {
    if (!selected) return
    const refresh = () =>
      void open(selected).catch((e) => {
        if (selection.current === selected) {
          setError(errorText(e))
          setDetail(undefined)
        }
      })
    refresh()
    const timer = setInterval(refresh, 15000)
    return () => clearInterval(timer)
  }, [selected, open])
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void load().catch((e) => setError(errorText(e)))
    }, 15000)
    return () => clearInterval(timer)
  }, [load])
  useEffect(() => {
    if (!composeDeal) return
    let active = true
    void requestJson<ComposerContext>(
      `/api/mca/email/context?dealId=${encodeURIComponent(composeDeal)}`
    )
      .then((data) => {
        if (active) {
          setContext(data)
          setSenderId((current) =>
            data.senders.some((s) => s.id === current)
              ? current
              : (data.senders.find((s) => s.conversationReady && s.isDefault)
                  ?.id ??
                data.senders.find((s) => s.conversationReady)?.id ??
                "")
          )
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e))
      })
    return () => {
      active = false
    }
  }, [composeDeal])
  useEffect(() => {
    if (!isNew || dealId) return
    const controller = new AbortController(),
      timer = setTimeout(() => {
        void requestJson<{ deals: typeof deals }>(
          `/api/mca/deals?q=${encodeURIComponent(query)}`,
          { signal: controller.signal }
        )
          .then((data) => setDeals(data.deals.slice(0, 30)))
          .catch((e) => {
            if (!controller.signal.aborted) setError(errorText(e))
          })
      }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, isNew, dealId])
  function switchDraft(
    newConversation: boolean,
    id: string | null,
    newDeal = composeDeal
  ) {
    if (!newConversation && id === selected) return
    draftStore.current.set(draftId, {
      body,
      subject,
      senderId,
      key: sendKey.current,
    })
    const saved = draftStore.current.get(
      newConversation ? `new:${newDeal}` : `reply:${id}`
    )
    setBody(saved?.body ?? "")
    setSubject(saved?.subject ?? "")
    setSenderId(
      saved?.senderId ??
        context?.senders.find((s) => s.conversationReady)?.id ??
        ""
    )
    sendKey.current = saved?.key ?? null
    setError("")
    setNotice("")
    setDetail(undefined)
    setIsNew(newConversation)
    setSelected(id)
    selection.current = id
    if (newDeal !== composeDeal) {
      setContext(undefined)
      setComposeDeal(newDeal)
    }
  }
  async function send() {
    setBusy(true)
    setError("")
    setNotice("")
    sendKey.current ??= crypto.randomUUID()
    try {
      const result = await requestJson<{
        conversationId: string
        state: string
      }>(
        isNew
          ? "/api/mca/email/messages"
          : `/api/mca/email/conversations/${selected}`,
        {
          method: "POST",
          body: JSON.stringify(
            isNew
              ? {
                  dealId: composeDeal,
                  senderId,
                  recipient: context?.recipient,
                  subject,
                  body,
                  idempotencyKey: sendKey.current,
                }
              : { body, idempotencyKey: sendKey.current }
          ),
        }
      )
      if (["failed", "unknown", "blocked"].includes(result.state)) {
        setError(
          `This email is ${result.state}. Your draft is preserved; check the conversation status before sending again.`
        )
        await load()
        return
      }
      draftStore.current.delete(draftId)
      setBody("")
      setSubject("")
      sendKey.current = null
      setIsNew(false)
      setSelected(result.conversationId)
      selection.current = result.conversationId
      setNotice("Email queued. Delivery status will update here.")
      await load()
      await open(result.conversationId)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  async function retry(id: string) {
    setBusy(true)
    setError("")
    try {
      await requestJson(`/api/mca/email/messages/${id}/retry`, {
        method: "POST",
      })
      if (selected) await open(selected)
      setNotice("The failed email is queued for another attempt.")
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  const currentSender = context?.senders.find((s) => s.id === senderId)
  const waiting = detail?.messages.some((m) => pendingStates.has(m.state))
  return (
    <section className="space-y-4" aria-label="Email conversations">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <Mail className="size-5" />
            Email inbox
          </h2>
          <p className="text-sm text-muted-foreground">
            Conversations with your leads and merchants
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void load().catch((e) => setError(errorText(e)))}
          >
            <RefreshCw className="size-4" />
            Refresh
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => switchDraft(true, null)}
          >
            <Plus className="size-4" />
            New email
          </Button>
        </div>
      </div>
      {showConnections ? (
        <PersonalEmailConnections
          onChanged={() => void load().catch((e) => setError(errorText(e)))}
        />
      ) : (
        <Link
          href="/mail#email-connections"
          className="inline-block text-sm underline"
        >
          Manage your email connection
        </Link>
      )}
      {error && (
        <p
          role="alert"
          className="rounded border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <div className="grid min-h-96 overflow-hidden rounded-xl border md:grid-cols-[minmax(200px,280px)_1fr]">
        <aside className="max-h-[650px] space-y-2 overflow-y-auto border-b bg-muted/20 p-3 md:border-r md:border-b-0">
          {loading ? (
            <p className="p-3 text-sm" role="status">
              Loading conversations…
            </p>
          ) : !threads.length ? (
            <p className="p-3 text-sm text-muted-foreground">
              No email conversations yet. Start an email with a saved lead or
              merchant.
            </p>
          ) : (
            threads.map((t) => (
              <button
                type="button"
                key={t.id}
                disabled={busy}
                aria-pressed={selected === t.id}
                className={`w-full rounded-lg p-3 text-left hover:bg-muted ${selected === t.id ? "bg-muted" : ""}`}
                onClick={() => switchDraft(false, t.id)}
              >
                <p className="truncate text-sm font-medium">
                  {t.recipient}
                  {t.unread > 0 && <Badge className="ml-2">{t.unread}</Badge>}
                </p>
                <p className="truncate text-sm">{t.subject}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {t.senderAddress} ·{" "}
                  {new Date(t.updatedAt).toLocaleDateString()}
                </p>
              </button>
            ))
          )}
          {next && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void load(next).catch((e) => setError(errorText(e)))
              }
            >
              Load more conversations
            </Button>
          )}
        </aside>
        <div className="min-w-0 space-y-4 p-4">
          {isNew ? (
            <>
              <h3 className="font-medium">New email</h3>
              {!dealId && (
                <div className="space-y-2">
                  <Label htmlFor="email-lead-search">
                    Find a lead or merchant
                  </Label>
                  <Input
                    id="email-lead-search"
                    placeholder="Search merchant name…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <select
                    aria-label="Lead or merchant"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={composeDeal}
                    onChange={(e) => switchDraft(true, null, e.target.value)}
                  >
                    <option value="">Choose a lead or merchant</option>
                    {deals.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.legalName || d.displayId}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {composeDeal && !context && (
                <p role="status" className="text-sm">
                  Loading contact and senders…
                </p>
              )}
              {context && (
                <>
                  <Label className="grid gap-2">
                    To
                    <Input
                      value={context.recipient ?? ""}
                      readOnly
                      placeholder="No saved email address"
                    />
                  </Label>
                  {!context.recipient && (
                    <p className="text-sm text-muted-foreground">
                      Add an email address to this contact in{" "}
                      <Link
                        className="underline"
                        href={`/pipeline?deal=${composeDeal}`}
                      >
                        the deal application
                      </Link>
                      .
                    </p>
                  )}
                  <Label className="grid gap-2">
                    From
                    <select
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      value={senderId}
                      onChange={(e) => {
                        setSenderId(e.target.value)
                        sendKey.current = null
                      }}
                    >
                      <option value="">Select your work email</option>
                      {context.senders.map((s) => (
                        <option
                          key={s.id}
                          value={s.id}
                          disabled={!s.conversationReady}
                        >
                          {s.fromAddress}
                          {!s.conversationReady ? " — reconnect required" : ""}
                        </option>
                      ))}
                    </select>
                  </Label>
                  {!context.senders.some((s) => s.conversationReady) && (
                    <p className="text-sm text-muted-foreground">
                      Connect your Gmail or Microsoft account above, or{" "}
                      <Link
                        href="/mail#email-connections"
                        className="underline"
                      >
                        open email setup
                      </Link>
                      .
                    </p>
                  )}
                  <Label className="grid gap-2">
                    Subject
                    <Input
                      value={subject}
                      maxLength={200}
                      onChange={(e) => {
                        setSubject(e.target.value)
                        sendKey.current = null
                      }}
                    />
                  </Label>
                </>
              )}
            </>
          ) : detail ? (
            <>
              <div>
                <h3 className="font-medium">{detail.conversation.subject}</h3>
                <p className="break-all text-sm text-muted-foreground">
                  {detail.conversation.senderAddress} ↔{" "}
                  {detail.conversation.recipient}
                </p>
                <Link
                  className="text-xs underline"
                  href={`/pipeline?deal=${detail.conversation.dealId}&tab=messages`}
                >
                  Open deal
                </Link>
              </div>
              {detail.conversation.syncError && (
                <p
                  role="status"
                  className="text-sm text-amber-700 dark:text-amber-300"
                >
                  {detail.conversation.syncError}{" "}
                  <Link href="/mail#email-connections" className="underline">
                    Email setup
                  </Link>
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {detail.conversation.lastSyncedAt
                  ? `Replies last checked ${new Date(detail.conversation.lastSyncedAt).toLocaleTimeString()}`
                  : "Waiting for first reply check"}
              </p>
              <div className="max-h-[480px] space-y-3 overflow-y-auto">
                {detail.nextCursor && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        const page = await requestJson<MessagePage>(
                          `/api/mca/email/conversations/${selected}?before=${detail.nextCursor}`
                        )
                        if (selection.current === page.conversation.id)
                          setDetail((current) =>
                            current
                              ? {
                                  ...current,
                                  messages: [
                                    ...page.messages,
                                    ...current.messages,
                                  ],
                                  nextCursor: page.nextCursor,
                                }
                              : current
                          )
                      } catch (e) {
                        setError(errorText(e))
                      }
                    }}
                  >
                    Earlier messages
                  </Button>
                )}
                {detail.messages.map((m) => (
                  <article
                    key={m.id}
                    className={`max-w-[95%] rounded-lg p-3 ${m.direction === "outbound" ? "ml-auto bg-primary/10" : "bg-muted"}`}
                  >
                    <p className="mb-2 break-all text-xs text-muted-foreground">
                      {m.author}
                    </p>
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {m.body}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {new Date(m.createdAt).toLocaleString()} · {m.state}
                    </p>
                    {m.state === "failed" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        disabled={busy || Boolean(waiting)}
                        onClick={() => void retry(m.id)}
                      >
                        Retry failed email
                      </Button>
                    )}
                    {m.error && (
                      <p className="mt-2 text-xs text-destructive">{m.error}</p>
                    )}
                  </article>
                ))}
              </div>
            </>
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {selected
                ? "Loading conversation…"
                : "Choose a conversation or start a new email."}
            </p>
          )}
          {((isNew && context) || (!isNew && detail)) && (
            <div className="space-y-3">
              <Label className="grid gap-2">
                {isNew ? "Message" : "Reply"}
                <Textarea
                  aria-label={isNew ? "Email message" : "Email reply"}
                  rows={5}
                  value={body}
                  maxLength={20000}
                  onChange={(e) => {
                    setBody(e.target.value)
                    sendKey.current = null
                  }}
                  placeholder="Write your message…"
                  disabled={busy}
                />
              </Label>
              {isNew && currentSender?.signature && (
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                  Signature added when sent:
                  <br />
                  {currentSender.signature}
                </p>
              )}
              {!isNew && waiting && (
                <p role="status" className="text-sm text-muted-foreground">
                  Waiting for the previous send to be confirmed. Check its
                  status above before replying.
                </p>
              )}
              <Button
                disabled={
                  busy ||
                  !body.trim() ||
                  (isNew
                    ? !context?.recipient ||
                      !currentSender?.conversationReady ||
                      !subject.trim()
                    : Boolean(waiting))
                }
                onClick={() => void send()}
              >
                <Send className="size-4" />
                {busy ? "Queueing…" : isNew ? "Send email" : "Send reply"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
