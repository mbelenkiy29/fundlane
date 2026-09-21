"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Mail,
  MessageSquareText,
  Send,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RequestError, requestJson } from "@/lib/mca/client"
import { cn } from "@/lib/utils"
import type { SmsAccount, SmsMessage } from "@/lib/mca/sms/contracts"
import type { EmailSender } from "@/lib/mca/senders/contracts"
import type {
  ConversationPage,
  ConversationSummary,
  MessagePage,
} from "@/lib/mca/email-conversations/contracts"

export type ChatMessageDraft = {
  channel: "sms" | "email"
  body: string
  dealId: string
}

type Channel = "sms" | "email"

type ConsentState = "loading" | "unknown" | "opted_in" | "opted_out"
type ComposerAccount = Pick<
  SmsAccount,
  | "id"
  | "label"
  | "provider"
  | "senderMasked"
  | "providerConfigured"
  | "isDefault"
  | "state"
>
type ComposerMessage = SmsMessage & { body: string }
type ComposerContext = {
  dealId: string
  merchantName: string
  recipient: string | null
  recipientMasked: string | null
  consent: {
    state: string
    recipientMasked?: string
    effectiveAt?: string
    source?: string
  }
  accounts: ComposerAccount[]
  messages: ComposerMessage[]
}
type DirectPreview = {
  recipient: string
  recipientMasked: string
  body: string
  accountId: string
  provider: string
  senderMasked: string
  providerConfigured: boolean
  consentState: string
  canSend: boolean
  block?: { code: string; message: string }
}
type SmsThread = {
  id: string
  accountId: string
  dealId: string | null
  recipient: string
  unread: number
}
type SmsThreadDetail = {
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
type EmailComposerContext = {
  dealId: string
  recipient: string | null
  senders: EmailSender[]
}

const providerLabel: Record<string, string> = {
  twilio: "Twilio",
  entrance: "Entrance",
  texttorrent: "TextTorrent",
  textus: "TextUs",
  openphone: "OpenPhone",
  gohighlevel: "GoHighLevel",
}

function errorText(error: unknown): string {
  if (error instanceof RequestError) {
    const fields = Object.values(error.fieldErrors ?? {})
      .flat()
      .filter(Boolean)
    return fields.length ? fields.join(" ") : error.message
  }
  return error instanceof Error
    ? error.message
    : "The message could not be completed."
}

const emailPendingStates = new Set([
  "queued",
  "sending",
  "accepted",
  "unknown",
  "blocked",
])

function consentState(value: string): ConsentState {
  if (value === "opted_in" || value === "opted_out") return value
  return "unknown"
}

function ChatMessageBubble({
  direction,
  body,
  meta,
  state,
}: {
  direction: "inbound" | "outbound"
  body: string
  meta: string
  state?: string
}) {
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-xl px-3 py-2 text-sm",
        direction === "outbound" ? "ml-auto bg-primary/10" : "bg-muted/60"
      )}
    >
      <p className="whitespace-pre-wrap break-words">{body}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {direction === "outbound" ? "Sent" : "Received"} · {meta}
        {state && (
          <>
            {" "}
            · <span className="capitalize">{state}</span>
          </>
        )}
      </p>
    </div>
  )
}

export function ChatMessages({
  dealId,
  surface = "drawer",
  draft,
}: {
  dealId: string
  surface?: "drawer" | "page"
  draft?: ChatMessageDraft | null
}) {
  const [channel, setChannel] = useState<Channel>("sms")
  const [open, setOpen] = useState(true)
  const [pendingDraft, setPendingDraft] = useState<ChatMessageDraft | null>(null)
  const [prevDraft, setPrevDraft] = useState<ChatMessageDraft | null>(null)
  // Adjust state when the assistant emits a new draft (render-time pattern).
  if (draft !== prevDraft) {
    setPrevDraft(draft ?? null)
    if (draft && draft.dealId === dealId) {
      setChannel(draft.channel)
      setOpen(true)
      setPendingDraft(draft)
    }
  }
  const initialDraft =
    pendingDraft && pendingDraft.dealId === dealId ? pendingDraft : null

  return (
    <section
      className={cn(
        "shrink-0 border-t bg-background",
        surface === "page" ? "border-b" : ""
      )}
      aria-label="Merchant messages for this deal"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs font-medium text-muted-foreground"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronUp className="size-3.5" />
          )}
          Messages
        </Button>
        <div
          className="ml-auto flex items-center gap-1 rounded-md border bg-muted/40 p-0.5"
          role="tablist"
          aria-label="Message channel"
        >
          <TabButton
            active={channel === "sms"}
            onClick={() => setChannel("sms")}
            label="SMS"
            icon={<MessageSquareText className="size-3" />}
          />
          <TabButton
            active={channel === "email"}
            onClick={() => setChannel("email")}
            label="Email"
            icon={<Mail className="size-3" />}
          />
        </div>
        <Link
          href={channel === "sms" ? "/sms" : "/mail"}
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Inbox
        </Link>
      </div>
      {open && (
        <div className="border-t px-3 pb-3 pt-2">
          {channel === "sms" ? (
            <SmsMessaging
              dealId={dealId}
              surface={surface}
              draftBody={initialDraft?.channel === "sms" ? initialDraft.body : null}
              onDraftConsumed={() => setPendingDraft(null)}
            />
          ) : (
            <EmailMessaging
              dealId={dealId}
              surface={surface}
              draftBody={
                initialDraft?.channel === "email" ? initialDraft.body : null
              }
              onDraftConsumed={() => setPendingDraft(null)}
            />
          )}
        </div>
      )}
    </section>
  )
}

function TabButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function SmsMessaging({
  dealId,
  surface,
  draftBody,
  onDraftConsumed,
}: {
  dealId: string
  surface: "drawer" | "page"
  draftBody: string | null
  onDraftConsumed: () => void
}) {
  const [context, setContext] = useState<ComposerContext>()
  const [threads, setThreads] = useState<SmsThread[]>([])
  const [thread, setThread] = useState<SmsThreadDetail>()
  const [accountId, setAccountId] = useState("")
  const [body, setBody] = useState(draftBody ?? "")
  const [evidence, setEvidence] = useState("")
  const [preview, setPreview] = useState<DirectPreview>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const sendKey = useRef(crypto.randomUUID())
  const consentKey = useRef(new Map<string, string>())
  const draftReady = useRef(Boolean(draftBody))
  const bodyDirty = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const data = await requestJson<ComposerContext>(
        `/api/mca/sms/messages?dealId=${encodeURIComponent(dealId)}`
      )
      setContext(data)
      setAccountId((current) =>
        data.accounts.some((account) => account.id === current)
          ? current
          : (data.accounts.find(
              (account) => account.isDefault && account.providerConfigured
            )?.id ??
              data.accounts.find((account) => account.providerConfigured)?.id ??
              data.accounts[0]?.id ??
              "")
      )
      const list = await requestJson<{ conversations: SmsThread[] }>(
        `/api/mca/sms/conversations?dealId=${encodeURIComponent(dealId)}`
      )
      setThreads(list.conversations)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [dealId])

  useEffect(() => {
    void load()
  }, [load])

  const openThread = useCallback(async (id: string) => {
    setError("")
    try {
      const detail = await requestJson<SmsThreadDetail>(
        `/api/mca/sms/conversations?id=${encodeURIComponent(id)}`
      )
      setThread(detail)
      await requestJson("/api/mca/sms/conversations", {
        method: "POST",
        body: JSON.stringify({ id }),
      })
      void load()
    } catch (caught) {
      setError(errorText(caught))
    }
  }, [load])

  // Re-fetch the composer context after each send so the thread updates.
  const refresh = useCallback(async () => {
    try {
      const data = await requestJson<ComposerContext>(
        `/api/mca/sms/messages?dealId=${encodeURIComponent(dealId)}`
      )
      setContext(data)
      const list = await requestJson<{ conversations: SmsThread[] }>(
        `/api/mca/sms/conversations?dealId=${encodeURIComponent(dealId)}`
      )
      setThreads(list.conversations)
      if (list.conversations[0] && list.conversations[0].id !== thread?.id)
        await openThread(list.conversations[0].id)
    } catch (caught) {
      setError(errorText(caught))
    }
  }, [dealId, thread?.id, openThread])

  // Reset the composer when the deal changes.
  useEffect(() => {
    bodyDirty.current = false
    draftReady.current = false
    setBody("")
    setPreview(undefined)
    sendKey.current = crypto.randomUUID()
  }, [dealId])

  // Apply an assistant-provided draft exactly once.
  useEffect(() => {
    if (!draftBody || draftReady.current || bodyDirty.current) return
    setBody(draftBody)
    draftReady.current = true
    onDraftConsumed()
  }, [draftBody, onDraftConsumed])

  // Open the most recent conversation so the thread is already loaded.
  useEffect(() => {
    if (!threads.length || thread) return
    void openThread(threads[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads])

  const consent: ConsentState = context
    ? consentState(context.consent.state)
    : "loading"
  const gate = useMemo(() => {
    if (loading) return "loading"
    if (!context?.recipient) return "no_recipient"
    if (!context.accounts.length) return "no_account"
    if (!body.trim()) return "validation"
    if (consent === "opted_out") return "opted_out"
    if (consent !== "opted_in") return "consent_required"
    const selected = context.accounts.find((account) => account.id === accountId)
    if (!selected) return "validation"
    if (!selected.providerConfigured) return "provider_unconfigured"
    if (!preview || preview.body !== body || preview.accountId !== accountId)
      return "needs_preview"
    if (!preview.canSend) return "preview_blocked"
    return "ready"
  }, [loading, context, accountId, consent, body, preview])

  async function recordConsent(state: "opted_in" | "opted_out") {
    if (!context?.recipient || !evidence.trim()) return
    const scope = `consent-${state}`
    const existing = consentKey.current.get(scope) ?? crypto.randomUUID()
    consentKey.current.set(scope, existing)
    setBusy(scope)
    setError("")
    setNotice("")
    try {
      await requestJson("/api/mca/sms/consent", {
        method: "POST",
        body: JSON.stringify({
          dealId,
          recipient: context.recipient,
          state,
          evidence: evidence.trim(),
          idempotencyKey: existing,
        }),
      })
      consentKey.current.delete(scope)
      setEvidence("")
      setNotice(
        state === "opted_in"
          ? "Merchant text consent recorded."
          : "Merchant text opt-out recorded."
      )
      await load()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(undefined)
    }
  }

  async function savePreview() {
    if (!context?.recipient) return
    setBusy("preview")
    setError("")
    setNotice("")
    try {
      const next = await requestJson<DirectPreview>(
        "/api/mca/sms/messages",
        {
          method: "POST",
          body: JSON.stringify({
            dealId,
            recipient: context.recipient,
            body,
            senderAccountId: accountId,
            idempotencyKey: sendKey.current,
            preview: true,
          }),
        }
      )
      setPreview(next)
      if (!next.canSend && next.block) setError(next.block.message)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(undefined)
    }
  }

  async function send() {
    if (!context?.recipient || gate !== "ready" || !preview) return
    setBusy("send")
    setError("")
    setNotice("")
    try {
      const result = await requestJson<{
        state: string
        messageId?: string
        errorMessage?: string
      }>("/api/mca/sms/messages", {
        method: "POST",
        body: JSON.stringify({
          dealId,
          recipient: context.recipient,
          body: preview.body,
          senderAccountId: preview.accountId,
          idempotencyKey: sendKey.current,
        }),
      })
      if (result.state === "failed")
        setError(result.errorMessage ?? "The provider rejected the text.")
      else if (result.state === "unknown")
        setError(
          result.errorMessage ??
            "The provider outcome is unknown. Check provider activity before retrying."
        )
      else {
        sendKey.current = crypto.randomUUID()
        bodyDirty.current = true
        setBody("")
        setPreview(undefined)
        setNotice("Text accepted. Delivery status updates in this thread.")
      }
      await refresh()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(undefined)
    }
  }

  if (loading && !context)
    return (
      <p className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Loading merchant messages…
      </p>
    )
  if (!context?.recipient)
    return (
      <p className="py-2 text-xs text-muted-foreground">
        Save a merchant mobile number on this deal to start texting from here.
      </p>
    )

  const threadMessages = thread
    ? thread.messages
    : context.messages
        .slice()
        .reverse()
        .map((message) => ({
          id: message.id,
          direction: "outbound" as const,
          body: message.body,
          state: message.state,
          createdAt: message.createdAt,
          error: message.errorMessage ?? null,
        }))
  const inboxHref = "/sms"

  return (
    <div className="grid gap-2">
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-emerald-700">
          {notice}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {context.merchantName}
        </span>
        <span>{context.recipient}</span>
        <Badge variant={consent === "opted_in" ? "default" : "outline"}>
          {consent === "loading" ? "…" : consent.replace(/_/g, " ")}
        </Badge>
      </div>

      <div
        className={cn(
          "space-y-1.5 overflow-y-auto rounded-lg border bg-muted/20 p-2",
          surface === "page" ? "max-h-64" : "max-h-40"
        )}
        role="log"
        aria-label="SMS conversation"
      >
        {!threadMessages.length && (
          <p className="py-2 text-center text-xs text-muted-foreground">
            No texts yet. Compose the first message below.
          </p>
        )}
        {threadMessages.map((message) => (
          <ChatMessageBubble
            key={message.id}
            direction={
              message.direction === "outbound" ? "outbound" : "inbound"
            }
            body={message.body}
            state={message.state}
            meta={`${new Date(message.createdAt).toLocaleString()}${
              message.error ? ` · ${message.error}` : ""
            }`}
          />
        ))}
      </div>

      {["consent_required", "opted_out", "unknown"].includes(gate) && (
        <div className="grid gap-1.5 rounded-lg border p-2">
          <Label className="grid gap-1 text-xs">
            Consent evidence
            <Input
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
              placeholder="How and when the merchant opted in"
              maxLength={500}
            />
          </Label>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(busy) || !evidence.trim()}
              onClick={() => void recordConsent("opted_in")}
            >
              {busy === "consent-opted_in" && (
                <Loader2 className="animate-spin" />
              )}
              Record opt-in
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={Boolean(busy) || !evidence.trim()}
              onClick={() => void recordConsent("opted_out")}
            >
              {busy === "consent-opted_out" && (
                <Loader2 className="animate-spin" />
              )}
              Record opt-out
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <select
          aria-label="Assigned text account"
          value={accountId}
          onChange={(event) => {
            setAccountId(event.target.value)
            setPreview(undefined)
          }}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
        >
          {!accountId && <option value="">Choose an account</option>}
          {context.accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label} · {providerLabel[account.provider] ?? account.provider} ·{" "}
              {account.senderMasked}
              {account.providerConfigured ? "" : " · credentials absent"}
            </option>
          ))}
        </select>
        <Link
          href={inboxHref}
          className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Open inbox
        </Link>
      </div>

      <div className="flex items-end gap-2">
        <Textarea
          aria-label="SMS reply"
          value={body}
          maxLength={1600}
          rows={2}
          className="min-h-14 flex-1 resize-none text-sm"
          placeholder="Exact text the merchant will receive"
          onChange={(event) => {
            bodyDirty.current = true
            setBody(event.target.value)
            setPreview(undefined)
          }}
        />
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={Boolean(busy) || !body.trim()}
            onClick={() => void savePreview()}
          >
            {busy === "preview" && <Loader2 className="animate-spin" />}
            Preview
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={Boolean(busy) || gate !== "ready"}
            onClick={() => void send()}
          >
            {busy === "send" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
            Send
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {gate === "needs_preview"
          ? "Preview the exact text before sending."
          : gate === "consent_required"
            ? "Consent is checked again before every send."
            : gate === "opted_out"
              ? "This merchant opted out of text messages."
              : gate === "provider_unconfigured"
                ? "This account's provider is not configured."
                : gate === "ready"
                  ? "Ready to send after preview."
                  : " "}
      </p>
    </div>
  )
}

function EmailMessaging({
  dealId,
  surface,
  draftBody,
  onDraftConsumed,
}: {
  dealId: string
  surface: "drawer" | "page"
  draftBody: string | null
  onDraftConsumed: () => void
}) {
  const [context, setContext] = useState<EmailComposerContext>()
  const [threads, setThreads] = useState<ConversationSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<MessagePage>()
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState(draftBody ?? "")
  const [senderId, setSenderId] = useState("")
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const sendKey = useRef<string | null>(null)
  const draftReady = useRef(Boolean(draftBody))

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const c = await requestJson<EmailComposerContext>(
        `/api/mca/email/context?dealId=${encodeURIComponent(dealId)}`
      )
      setContext(c)
      setSenderId((current) =>
        c.senders.some((s) => s.id === current)
          ? current
          : (c.senders.find((s) => s.conversationReady && s.isDefault)?.id ??
              c.senders.find((s) => s.conversationReady)?.id ??
              "")
      )
      const page = await requestJson<ConversationPage>(
        `/api/mca/email/conversations?dealId=${encodeURIComponent(dealId)}`
      )
      setThreads(page.conversations)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [dealId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!threads.length) return
    const open = async (id: string) => {
      setSelected(id)
      setError("")
      try {
        const page = await requestJson<MessagePage>(
          `/api/mca/email/conversations/${encodeURIComponent(id)}`
        )
        setDetail(page)
        const sequence = page.messages.at(-1)?.sequence
        if (sequence)
          await requestJson(`/api/mca/email/conversations/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ sequence }),
          })
        setThreads((old) =>
          old.map((t) => (t.id === id ? { ...t, unread: 0 } : t))
        )
      } catch (caught) {
        setError(errorText(caught))
      }
    }
    void open(threads[0].id)
  }, [threads])

  useEffect(() => {
    draftReady.current = false
    setBody("")
    setSubject("")
    setSelected(null)
    setDetail(undefined)
    sendKey.current = null
  }, [dealId])

  useEffect(() => {
    if (draftBody && !draftReady.current) {
      setBody(draftBody)
      draftReady.current = true
      onDraftConsumed()
    }
  }, [draftBody, onDraftConsumed])

  async function send() {
    setBusy(true)
    setError("")
    setNotice("")
    sendKey.current ??= crypto.randomUUID()
    try {
      const recipient = context?.recipient
      const isNew = !selected
      if (isNew && (!recipient || !subject.trim() || !senderId)) {
        setError("Choose a sender, a subject, and a message body.")
        return
      }
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
                  dealId,
                  senderId,
                  recipient,
                  subject: subject.trim(),
                  body,
                  idempotencyKey: sendKey.current,
                }
              : { body, idempotencyKey: sendKey.current }
          ),
        }
      )
      if (["failed", "unknown", "blocked"].includes(result.state))
        setError(
          `This email is ${result.state}. Your draft is preserved; check the conversation status before sending again.`
        )
      else {
        sendKey.current = null
        setBody("")
        setSubject("")
        setNotice("Email queued. Delivery status will update here.")
        setSelected(result.conversationId)
        await load()
      }
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  if (loading && !context)
    return (
      <p className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Loading merchant email…
      </p>
    )

  const senders = context?.senders.filter((s) => s.conversationReady) ?? []
  const messages = detail?.messages ?? []

  if (!senders.length)
    return (
      <p className="py-2 text-xs text-muted-foreground">
        Connect an email sender in the{" "}
        <Link href="/mail" className="underline underline-offset-2">
          email inbox
        </Link>{" "}
        to message this merchant from here.
      </p>
    )

  return (
    <div className="grid gap-2">
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-emerald-700">
          {notice}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {detail?.conversation.recipient ?? context?.recipient ?? "Email"}
        </span>
        {detail?.conversation.subject && (
          <span className="truncate">{detail.conversation.subject}</span>
        )}
        <Badge variant="outline">
          {selected ? "reply" : "new message"}
        </Badge>
      </div>

      <div
        className={cn(
          "space-y-1.5 overflow-y-auto rounded-lg border bg-muted/20 p-2",
          surface === "page" ? "max-h-64" : "max-h-40"
        )}
        role="log"
        aria-label="Email conversation"
      >
        {!messages.length && (
          <p className="py-2 text-center text-xs text-muted-foreground">
            No messages on this thread yet.
          </p>
        )}
        {messages.map((message) => (
          <ChatMessageBubble
            key={message.id}
            direction={
              message.direction === "inbound" ? "inbound" : "outbound"
            }
            body={message.body}
            state={message.state}
            meta={`${message.author} · ${new Date(
              message.createdAt
            ).toLocaleString()}${
              message.error ? ` · ${message.error}` : ""
            }`}
          />
        ))}
      </div>

      {!selected && (
        <Label className="grid gap-1 text-xs">
          Subject
          <Input
            value={subject}
            maxLength={200}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Subject line"
          />
        </Label>
      )}

      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Email message"
          value={body}
          maxLength={20000}
          rows={2}
          className="min-h-14 flex-1 resize-none text-sm"
          placeholder={
            selected
              ? "Reply to this conversation…"
              : "Message the merchant…"
          }
          onChange={(event) => setBody(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || !body.trim() || (selected ? false : !subject.trim())}
          onClick={() => void send()}
        >
          {busy ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          Send
        </Button>
      </div>
      {!selected && senders.length > 1 && (
        <Label className="grid gap-1 text-xs">
          From
          <select
            value={senderId}
            onChange={(event) => setSenderId(event.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            {!senderId && <option value="">Choose a sender</option>}
            {senders.map((sender) => (
              <option key={sender.id} value={sender.id}>
                {sender.fromName} · {sender.fromAddress}
              </option>
            ))}
          </select>
        </Label>
      )}
      {selected && emailPendingStates.has(detail?.messages.at(-1)?.state ?? "") && (
        <p className="text-[11px] text-muted-foreground">
          Wait for the previous message to clear before replying.
        </p>
      )}
    </div>
  )
}