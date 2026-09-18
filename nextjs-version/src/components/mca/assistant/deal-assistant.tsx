"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Bot,
  FileText,
  Loader2,
  Paperclip,
  Send,
  Square,
  X
} from "lucide-react"
import { AgentWorkflow } from "@/components/ui/ai-agent-response"
import { RichResponse } from "./rich-response"
import { FileCard } from "./file-card"
import { MemoryDialog } from "./memory-dialog"
import { QuestionCard } from "./question-card"
import type {
  Activity,
  AssistantFile
} from "@/lib/mca/assistant/experience-contracts"
import { CreditBalanceBadge } from "./credit-balance"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { deliveryLabel } from "@/lib/mca/assistant/contracts"
import type {
  AssistantCommand,
  AssistantEvent,
  ConversationView
} from "@/lib/mca/assistant/contracts"

function AssistantText({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let offset = 0
  // Only turn known internal record paths into links; message text never supplies HTML.
  const pattern =
    /(?:\[([^\]]{1,200})\]\()?((?:\/deals)\?deal=[A-Za-z0-9_-]+(?:&tab=[A-Za-z0-9_-]+)?)(?:\))?/g
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(offset, match.index))
    parts.push(
      <a
        key={match.index}
        href={match[2]}
        className="text-primary underline underline-offset-4"
      >
        {match[1] || "Open deal"}
      </a>
    )
    offset = match.index! + match[0].length
  }
  parts.push(text.slice(offset))
  return <>{parts}</>
}

const endpoint = "/api/mca/assistant"
const suggestions = [
  "Summarize this deal",
  "Check missing documents",
  "Analyze funder matches",
  "Draft a merchant follow-up"
]
async function json<T>(response: Response): Promise<T> {
  const data = await response.json()
  if (!response.ok)
    throw new Error(data.error?.message ?? "The assistant is unavailable.")
  return data as T
}

export function DealAssistant({
  dealId,
  conversationId,
  standalone = false,
  onChanged
}: {
  dealId?: string
  conversationId?: string
  standalone?: boolean
  onChanged: () => void
}) {
  const router = useRouter()
  const search = useSearchParams()
  const draftMessage = search.get("draft")
  const [enabled, setEnabled] = useState(false),
    [configured, setConfigured] = useState(false),
    [open, setOpen] = useState(standalone)
  const [view, setView] = useState<ConversationView | null>(null),
    [input, setInput] = useState(""),
    [busy, setBusy] = useState(false)
  const [partial, setPartial] = useState(""),
    [progress, setProgress] = useState(""),
    [error, setError] = useState("")
  const [rich, setRich] = useState(false),
    [filesEnabled, setFilesEnabled] = useState(false),
    [uploading, setUploading] = useState(false)
  const [activities, setActivities] = useState<Activity[]>([]),
    [attachments, setAttachments] = useState<AssistantFile[]>([]),
    [liveFiles, setLiveFiles] = useState<AssistantFile[]>([])
  const [library, setLibrary] = useState<AssistantFile[] | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const followOutput = useRef(true)
  const abort = useRef<AbortController | null>(null),
    conversation = useRef<string | null>(null),
    alive = useRef(true),
    scroll = useRef<HTMLDivElement>(null)
  const refreshParent = useRef(onChanged)
  const applyView = useCallback((v: ConversationView) => {
    setView(v)
    if (v.experience) {
      setActivities(v.experience.activities)
      setPartial(v.experience.partial ?? "")
    }
  }, [])
  useEffect(() => {
    refreshParent.current = onChanged
  }, [onChanged])
  const stop = useCallback(() => {
    abort.current?.abort()
    const id = conversation.current
    if (id)
      void fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", conversationId: id }),
        keepalive: true
      })
        .then((r) => json<ConversationView>(r))
        .then((v) => {
          if (alive.current) {
            applyView(v)
            setBusy(false)
            setProgress("")
          }
        })
        .catch(() => {})
  }, [applyView])
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    void fetch(endpoint, { signal: controller.signal })
      .then((r) =>
        json<{
          enabled: boolean
          configured: boolean
          experience?: boolean
          files?: boolean
        }>(r)
      )
      .then((s) => {
        setEnabled(s.enabled)
        setConfigured(s.configured)
        setRich(Boolean(s.experience))
        setFilesEnabled(Boolean(s.files))
      })
      .catch(() => {})
    return () => {
      alive.current = false
      controller.abort()
      stop()
    }
  }, [stop])
  useEffect(() => {
    const close = () => {
      if (conversation.current)
        navigator.sendBeacon(
          endpoint,
          new Blob(
            [
              JSON.stringify({
                action: "cancel",
                conversationId: conversation.current
              })
            ],
            { type: "application/json" }
          )
        )
    }
    window.addEventListener("pagehide", close)
    return () => window.removeEventListener("pagehide", close)
  }, [])
  useEffect(() => {
    if (followOutput.current)
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        behavior: "smooth"
      })
  }, [partial, view, progress])
  useEffect(() => {
    const refresh = () => {
      if (conversation.current)
        void fetch(`${endpoint}?conversationId=${conversation.current}`)
          .then((r) => json<ConversationView>(r))
          .then(applyView)
          .catch(() => {})
    }
    window.addEventListener("assistant-conversation-changed", refresh)
    return () =>
      window.removeEventListener("assistant-conversation-changed", refresh)
  }, [applyView])
  // Poll only an interrupted/reloaded active run; active streams supply their own events.
  useEffect(() => {
    if (!open || busy || view?.run?.status !== "running") return
    const timer = setInterval(() => {
      void fetch(`${endpoint}?conversationId=${view.id}`)
        .then((r) => json<ConversationView>(r))
        .then(applyView)
        .catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [open, busy, view?.id, view?.run?.status, applyView])
  const show = useCallback(async () => {
    setOpen(true)
    setError("")
    try {
      const state = await json<ConversationView>(
        await fetch(
          conversationId
            ? `${endpoint}?conversationId=${encodeURIComponent(conversationId)}`
            : `${endpoint}/conversations`,
          conversationId
            ? undefined
            : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dealId })
              }
        )
      )
      if (!alive.current) return
      conversation.current = state.id
      applyView(state)
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "Could not open assistant.")
    }
  }, [conversationId, dealId, applyView])
  useEffect(() => {
    if (standalone) void show()
  }, [standalone, show])
  const submit = useCallback(async (command: AssistantCommand) => {
    const controller = new AbortController()
    abort.current = controller
    setBusy(true)
    setPartial("")
    setError("")
    setProgress("Working on your request…")
    followOutput.current = true
    setLiveFiles([])
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: controller.signal
      })
      if (!response.ok) {
        await json(response)
        return
      }
      if (command.action === "message") {
        setInput("")
        setAttachments([])
        setView((v) =>
          v
            ? {
                ...v,
                messages: [
                  ...v.messages,
                  {
                    id: command.requestId,
                    role: "user",
                    text: command.message
                  }
                ]
              }
            : v
        )
      }
      if (!response.body) throw new Error("No response stream was returned.")
      const reader = response.body.getReader(),
        decoder = new TextDecoder()
      let pending = "",
        receivedState = false
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        pending += decoder.decode(chunk.value, { stream: true })
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.trim() || !alive.current) continue
          const event = JSON.parse(line) as AssistantEvent
          if (event.type === "delta") setPartial((p) => p + event.text)
          if (event.type === "progress") setProgress(event.text)
          if (event.type === "activity")
            setActivities((a) =>
              [
                ...a.filter((x) => x.id !== event.activity.id),
                event.activity
              ].sort(
                (x, y) =>
                  x.startedAt.localeCompare(y.startedAt) ||
                  x.sequence - y.sequence
              )
            )
          if (event.type === "file")
            setLiveFiles((f) => [
              ...f.filter((x) => x.id !== event.file.id),
              event.file
            ])
          if (event.type === "error") setError(event.text)
          if (event.type === "state") {
            applyView(event.state)
            setLiveFiles([])
            receivedState = true
            refreshParent.current()
          }
        }
      }
      if (!receivedState && !controller.signal.aborted)
        throw new Error(
          "The response was interrupted. Reopen the assistant to review saved results."
        )
    } catch (e) {
      if (alive.current && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Request failed.")
      if (alive.current && conversation.current)
        void fetch(`${endpoint}?conversationId=${conversation.current}`)
          .then((r) => json<ConversationView>(r))
          .then(applyView)
          .catch(() => {})
    } finally {
      if (alive.current) {
        setBusy(false)
        setProgress("")
      }
      window.dispatchEvent(new Event("mca-credits-changed"))
      abort.current = null
    }
  }, [applyView])
  const sentDraft = useRef(false)
  useEffect(() => {
    if (!standalone || !draftMessage || !view || sentDraft.current || !configured || busy) return
    if (view.messages.length) return
    if (view.run?.status === "running" || view.run?.status === "awaiting_approval" || view.run?.status === "awaiting_input") return
    sentDraft.current = true
    void submit({
      action: "message",
      conversationId: view.id,
      message: draftMessage.trim(),
      requestId: crypto.randomUUID(),
    })
    const params = new URLSearchParams(search.toString())
    params.delete("draft")
    router.replace(`/assistant?${params}`, { scroll: false })
  }, [standalone, draftMessage, view, configured, busy, search, router, submit])
  async function upload(selected: FileList | null) {
    if (!selected || !view) return
    const files = Array.from(selected)
    if (files.length + attachments.length > 5) {
      setError("Attach up to five files per request.")
      return
    }
    if (
      files.some((f) => f.size > 25 * 1024 * 1024) ||
      files.reduce((n, f) => n + f.size, 0) +
        attachments.reduce((n, f) => n + f.bytes, 0) >
        50 * 1024 * 1024
    ) {
      setError("Use files up to 25 MB each and 50 MB combined.")
      return
    }
    setUploading(true)
    setError("")
    try {
      for (const file of files) {
        const body = new FormData()
        body.set("conversationId", view.id)
        body.set("file", file)
        const result = await json<{ file: AssistantFile }>(
          await fetch(`${endpoint}/files`, { method: "POST", body })
        )
        setAttachments((a) => [...a, result.file])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.")
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }
  if (!enabled)
    return standalone ? (
      <p role="status" className="rounded-lg border p-4">
        AI Assistant is currently unavailable. Check the feature configuration
        with your administrator.
      </p>
    ) : null
  const active = busy || view?.run?.status === "running"
  const waiting =
    view?.run?.status === "awaiting_approval" ||
    view?.run?.status === "awaiting_input"
  const send = (text: string) => {
    if (view && text.trim() && !active && !waiting && !uploading)
      void submit({
        action: "message",
        conversationId: view.id,
        message: text.trim(),
        requestId: crypto.randomUUID(),
        ...(attachments.length
          ? { attachmentIds: attachments.map((f) => f.id) }
          : {})
      })
  }
  return (
    <section
      className={
        standalone
          ? "flex h-full min-h-0 flex-col bg-background"
          : "overflow-hidden rounded-xl border bg-background"
      }
      aria-label="AI assistant"
    >
      <div className={`flex items-center justify-between ${standalone ? "px-4 py-2" : "p-3"}`}>
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 max-w-[60%]"
          onClick={() => {
            if (standalone) return
            if (open) {
              stop()
              setOpen(false)
            } else void show()
          }}
        >
          <Bot className="mr-2 size-4" />
          <span className="truncate">
            {rich && standalone
              ? (view?.experience?.title ?? "AI Assistant")
              : "AI Assistant"}
          </span>
        </Button>
        {rich && open && (
          <div className="ml-auto flex items-center">
            <MemoryDialog />
            {filesEnabled && (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={library !== null}
                onClick={() => {
                  if (library) setLibrary(null)
                  else
                    void fetch(`${endpoint}/files`)
                      .then((r) => json<{ files: AssistantFile[] }>(r))
                      .then((d) => setLibrary(d.files))
                      .catch((e) => setError(e.message))
                }}
              >
                <FileText className="size-4" />
                <span className="hidden sm:inline">Files</span>
              </Button>
            )}
          </div>
        )}
        {open && !standalone && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close assistant"
            onClick={() => {
              stop()
              setOpen(false)
            }}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
      {open && (
        <div className={`flex min-h-0 flex-1 flex-col ${standalone ? "" : "space-y-4 border-t"} ${standalone ? "" : rich ? "p-4 sm:p-5" : "p-3"}`}>
          {!standalone && (
            <p className="text-xs text-muted-foreground">
              Works on this deal. Messages and submissions need your confirmation.
            </p>
          )}
          {!standalone && <CreditBalanceBadge />}
          {!configured && (
            <p role="status" className="text-sm">
              Your administrator needs to configure the assistant’s OpenAI
              connection.
            </p>
          )}
          <div
            ref={scroll}
            onScroll={(e) => {
              const el = e.currentTarget
              followOutput.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 70
            }}
            className={`${standalone ? "mx-auto min-h-0 w-full max-w-3xl flex-1 px-4 py-6" : "max-h-[45vh] pr-1"} space-y-6 overflow-y-auto overscroll-contain`}
            role="log"
            aria-label="Assistant conversation"
            aria-live="polite"
          >
            {view?.olderCursor && rich && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() =>
                  void fetch(
                    `${endpoint}/conversations/${view.id}/messages?before=${view.olderCursor}`
                  )
                    .then((r) =>
                      json<{
                        messages: ConversationView["messages"]
                        parts: NonNullable<
                          ConversationView["experience"]
                        >["parts"]
                        olderCursor: number | null
                      }>(r)
                    )
                    .then((page) =>
                      setView((v) =>
                        v
                          ? {
                              ...v,
                              messages: [
                                ...page.messages,
                                ...v.messages
                              ].filter(
                                (m, i, a) =>
                                  a.findIndex((x) => x.id === m.id) === i
                              ),
                              olderCursor: page.olderCursor,
                              experience: v.experience
                                ? {
                                    ...v.experience,
                                    parts: {
                                      ...page.parts,
                                      ...v.experience.parts
                                    }
                                  }
                                : undefined
                            }
                          : v
                      )
                    )
                    .catch((e) => setError(e.message))
                }
              >
                Load older messages
              </Button>
            )}
            {view?.messages.map((m) => (
              <div
                key={m.id}
                className={`min-w-0 text-sm ${
                  standalone
                    ? m.role === "user"
                      ? "ml-auto max-w-[80%] rounded-3xl bg-muted px-4 py-3"
                      : "w-full"
                    : `rounded-lg p-3 ${m.role === "user" ? "ml-6 bg-muted sm:ml-16" : rich ? "mr-2" : "mr-2 border"}`
                }`}
              >
                {!standalone && (
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {m.role === "user" ? "You" : "Assistant"}
                  </p>
                )}
                {rich && m.role === "assistant" ? (
                  <>
                    <AgentWorkflow
                      activities={activities.filter(
                        (a) => a.runId === view.experience?.parts[m.id]?.runId
                      )}
                    />
                    <RichResponse
                      text={m.text}
                      citations={view.experience?.parts[m.id]?.citations}
                    />
                  </>
                ) : (
                  <p className="whitespace-pre-wrap break-words">
                    <AssistantText text={m.text} />
                  </p>
                )}
                {view.experience?.parts[m.id]?.files?.map((f) => (
                  <div key={f.id} className="mt-3">
                    <FileCard
                      file={f}
                      onDelete={
                        !active
                          ? () =>
                              window.dispatchEvent(
                                new Event("assistant-conversation-changed")
                              )
                          : undefined
                      }
                    />
                  </div>
                ))}
              </div>
            ))}
            {rich && (
              <AgentWorkflow
                activities={activities.filter(
                  (a) =>
                    !view?.messages.some(
                      (m) =>
                        m.role === "assistant" &&
                        view.experience?.parts[m.id]?.runId === a.runId
                    )
                )}
              />
            )}
            {partial &&
              (rich ? (
                <RichResponse text={partial} copy={false} />
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm">
                  {partial}
                </p>
              ))}
            {liveFiles.map((f) => (
              <FileCard key={f.id} file={f} />
            ))}
            {view?.experience?.question && (
              <QuestionCard
                key={view.experience.question.id}
                question={view.experience.question}
                busy={active}
                onAnswer={(answers) =>
                  void submit({
                    action: "answer",
                    conversationId: view.id,
                    questionId: view.experience!.question!.id,
                    requestId: crypto.randomUUID(),
                    answers
                  })
                }
              />
            )}
            {view?.approvals.map((a) => (
              <div key={a.id} className="space-y-3 rounded-lg border p-3">
                <h3 className="text-sm font-semibold">{a.preview.title}</h3>
                <dl className="space-y-2">
                  {a.preview.details.map((d, i) => (
                    <div key={i}>
                      <dt className="text-xs text-muted-foreground">
                        {d.label}
                      </dt>
                      <dd className="whitespace-pre-wrap break-words text-sm">
                        {d.value || "None"}
                      </dd>
                    </div>
                  ))}
                </dl>
                {a.status === "pending" &&
                view.run?.status === "awaiting_approval" ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={active || !configured}
                      onClick={() =>
                        void submit({
                          action: "decision",
                          conversationId: view.id,
                          approvalId: a.id,
                          approve: true
                        })
                      }
                    >
                      Confirm{" "}
                      {a.preview.title.toLowerCase().includes("calendar")
                        ? "schedule"
                        : a.preview.title.startsWith("Submit")
                          ? "submission"
                          : "send"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={active}
                      onClick={() =>
                        void submit({
                          action: "decision",
                          conversationId: view.id,
                          approvalId: a.id,
                          approve: false
                        })
                      }
                    >
                      Reject
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {a.status === "executed"
                      ? deliveryLabel(a.result)
                      : a.status === "uncertain" || a.status === "executing"
                        ? "Delivery may have started. Check the deal’s delivery records before retrying."
                        : a.status === "stale"
                          ? "Preview changed. Request a new preview."
                          : a.status}
                  </p>
                )}
              </div>
            ))}
          </div>
          {library !== null && (
            <details open className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Your recent files · private to this company
              </summary>
              <div className="mt-3 max-h-64 space-y-2 overflow-auto">
                {library.length ? (
                  library.map((f) => (
                    <FileCard
                      key={f.id}
                      file={f}
                      onUse={
                        !active && !waiting
                          ? (file) => {
                              if (attachments.length >= 5) {
                                setError("Attach up to five files.")
                                return
                              }
                              setAttachments((a) =>
                                a.some((x) => x.id === file.id)
                                  ? a
                                  : [...a, file]
                              )
                              setLibrary(null)
                            }
                          : undefined
                      }
                      onDelete={() =>
                        setLibrary(
                          (l) => l?.filter((x) => x.id !== f.id) ?? null
                        )
                      }
                    />
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Upload a file or ask the assistant to create one.
                  </p>
                )}
              </div>
            </details>
          )}
          {!view?.messages.length && !standalone && (
            <div className="flex flex-wrap gap-2">
              {(rich && standalone && !dealId
                ? [
                    "Help me plan my week",
                    "Create a pipeline summary document",
                    "Research current small-business trends",
                    "Show my recent deals"
                  ]
                : standalone && !dealId
                  ? [
                      "Show my recent deals",
                      "Find deals with missing documents",
                      "Help me create a deal draft",
                      "Explain what you can do"
                    ]
                  : suggestions
              ).map((s) => (
                <Button
                  key={s}
                  variant="outline"
                  size="sm"
                  disabled={!view || !configured || active || uploading}
                  onClick={() => send(s)}
                >
                  {s}
                </Button>
              ))}
            </div>
          )}
          {(error || view?.run?.error) && (
            <p role="alert" className="text-sm text-destructive">
              {error || view?.run?.error}
            </p>
          )}
          {active && (
            <div
              role="status"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Loader2 className="size-3 animate-spin" />
              {progress || "Working…"}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              send(input)
            }}
            className={`space-y-2 rounded-3xl border bg-background p-2 focus-within:ring-2 focus-within:ring-ring/30 ${standalone ? "mx-auto mb-4 w-full max-w-3xl" : ""}`}
          >
            {!!attachments.length && (
              <div className="flex flex-wrap gap-2 px-1">
                {attachments.map((f) => (
                  <div
                    key={f.id}
                    className="flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
                  >
                    <Paperclip className="size-3 shrink-0" />
                    <span className="max-w-48 truncate">{f.name}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-5"
                      aria-label={`Remove ${f.name} attachment`}
                      onClick={() =>
                        setAttachments((a) => a.filter((x) => x.id !== f.id))
                      }
                    >
                      <X className="size-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                aria-label="Ask the deal assistant"
                placeholder={
                  rich
                    ? "Ask anything, or tell me what to work on…"
                    : "What would you like me to handle?"
                }
                value={input}
                maxLength={8000}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault()
                    send(input)
                  }
                }}
                className="min-h-16 resize-none border-0 shadow-none focus-visible:ring-0"
                disabled={
                  !view || !configured || active || waiting || uploading
                }
                rows={2}
              />
              {active || waiting ? (
                <Button type="button" variant="outline" onClick={stop}>
                  <Square className="mr-1 size-3" />
                  Stop
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Send request"
                  disabled={!view || !configured || !input.trim() || uploading}
                >
                  <Send className="size-4" />
                </Button>
              )}
            </div>
            {rich && (
              <div className="flex items-center justify-between gap-2 border-t px-1 pt-2 text-xs text-muted-foreground">
                <div>
                  {filesEnabled && (
                    <>
                      <input
                        ref={fileInput}
                        type="file"
                        accept=".pdf,.docx,.xlsx,.csv,.pptx,.txt,.md,.png,.jpg,.jpeg"
                        multiple
                        className="sr-only"
                        aria-label="Upload attachments"
                        tabIndex={-1}
                        onChange={(e) => void upload(e.target.files)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2"
                        disabled={!view || active || waiting || uploading}
                        onClick={() => fileInput.current?.click()}
                      >
                        {uploading ? (
                          <Loader2 className="size-3.5 motion-safe:animate-spin" />
                        ) : (
                          <Paperclip className="size-3.5" />
                        )}
                        {uploading ? "Scanning…" : "Attach"}
                      </Button>
                    </>
                  )}
                </div>
                <span>
                  1 credit per request
                  <span className="hidden sm:inline">
                    {" "}
                    · Shift + Enter for a new line
                  </span>
                </span>
              </div>
            )}
          </form>
          {(view?.dealId || dealId) && (
            <div className="flex flex-wrap gap-3 text-xs">
              <a
                className="underline"
                href={`/pipeline?deal=${encodeURIComponent(view?.dealId ?? dealId ?? "")}&tab=submissions`}
              >
                Submission records
              </a>
              <a
                className="underline"
                href={`/pipeline?deal=${encodeURIComponent(view?.dealId ?? dealId ?? "")}&tab=messages`}
              >
                Messages
              </a>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
