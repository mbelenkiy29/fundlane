"use client"
import { useCallback, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Bot, Plus, MessageSquare, Pencil, Search, Trash2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DealAssistant } from "./deal-assistant"
import { assistantJson, CreditBalanceBadge } from "./credit-balance"
import type { ConversationView } from "@/lib/mca/assistant/contracts"
type History = {
  id: string
  dealId: string | null
  createdAt: string
  title?: string
}
const starters = [
  "Summarize my pipeline",
  "Find deals with missing documents",
  "Plan my calendar from needs-action work",
  "Help me create a deal draft",
]
export function AssistantWorkspace() {
  const router = useRouter(),
    search = useSearchParams(),
    conversationId = search.get("conversation") ?? undefined
  const [deals, setDeals] = useState<
    Array<{ id: string; legalName: string; displayId: string }>
  >([])
  const [dealQuery, setDealQuery] = useState("")
  const [selectedDeal, setSelectedDeal] = useState("")
  const [showNavigation, setShowNavigation] = useState(false)
  const [historyQuery, setHistoryQuery] = useState(""),
    [nextBefore, setNextBefore] = useState<string | null>(null)
  const [editing, setEditing] = useState<History | null>(null),
    [title, setTitle] = useState(""),
    [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState("")
  useEffect(() => {
    const abort = new AbortController()
    const timer = setTimeout(() => {
      void assistantJson<{
        deals: Array<{ id: string; legalName: string; displayId: string }>
      }>(`/api/mca/deals?q=${encodeURIComponent(dealQuery)}`, {
        signal: abort.signal
      })
        .then((d) => setDeals(d.deals.slice(0, 100)))
        .catch(() => {})
    }, 200)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [dealQuery])
  const [history, setHistory] = useState<History[]>([]),
    [error, setError] = useState(""),
    [creating, setCreating] = useState(false)
  const refresh = useCallback(() => {
    void assistantJson<{ conversations: History[]; nextBefore: string | null }>(
      `/api/mca/assistant/conversations?q=${encodeURIComponent(historyQuery)}`
    )
      .then((d) => {
        setHistory(d.conversations)
        setNextBefore(d.nextBefore)
      })
      .catch((e) => setError(e.message))
  }, [historyQuery])
  useEffect(() => {
    const timer = setTimeout(refresh, 200)
    return () => clearTimeout(timer)
  }, [refresh])
  async function manage(remove = false) {
    if (!editing) return
    setSaving(true)
    setError("")
    try {
      await assistantJson(`/api/mca/assistant/conversations/${editing.id}`, {
        method: remove ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        ...(remove ? {} : { body: JSON.stringify({ title }) })
      })
      if (remove && editing.id === conversationId) router.push("/assistant")
      else {
        router.refresh()
        window.dispatchEvent(new Event("assistant-conversation-changed"))
      }
      setEditing(null)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update this chat.")
    } finally {
      setSaving(false)
    }
  }
  async function create(firstMessage?: string) {
    setCreating(true)
    setError("")
    try {
      const c = await assistantJson<ConversationView>(
        "/api/mca/assistant/conversations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dealId: selectedDeal || null })
        }
      )
      refresh()
      const params = new URLSearchParams()
      params.set("conversation", c.id)
      if (firstMessage?.trim()) params.set("draft", firstMessage.trim())
      router.push(`/assistant?${params}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create a chat.")
    } finally {
      setCreating(false)
    }
  }
  const rail = (
    <aside className="flex h-full min-h-0 w-full flex-col gap-3 bg-sidebar p-3 text-sidebar-foreground lg:w-[272px] lg:border-r lg:border-sidebar-border">
      <div className="space-y-1">
        <p className="text-sm font-medium">Chats</p>
        <div className="text-[11px] leading-snug [&_a]:text-[11px]">
          <CreditBalanceBadge />
        </div>
      </div>
      <Button
        className="w-full justify-start"
        disabled={creating}
        onClick={() => void create()}
      >
        <Plus className="size-4" />
        New chat
      </Button>
      <div className="space-y-1.5">
        <label htmlFor="assistant-deal-search" className="block text-xs font-medium">
          Find a deal
        </label>
        <Input
          id="assistant-deal-search"
          placeholder="Search business name"
          value={dealQuery}
          onChange={(e) => {
            setDealQuery(e.target.value)
            setSelectedDeal("")
          }}
        />
        <label htmlFor="assistant-deal-context" className="block text-xs font-medium">
          Conversation context
        </label>
        <select
          id="assistant-deal-context"
          className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          value={selectedDeal}
          onChange={(e) => setSelectedDeal(e.target.value)}
        >
          <option value="">Company workspace</option>
          {deals.map((d) => (
            <option key={d.id} value={d.id}>
              {d.legalName || d.displayId}
            </option>
          ))}
        </select>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
        <Input
          aria-label="Search conversations"
          value={historyQuery}
          onChange={(e) => setHistoryQuery(e.target.value)}
          maxLength={200}
          placeholder="Search conversations"
          className="pl-8"
        />
      </div>
      <nav aria-label="Assistant chat history" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {history.map((c) => (
          <div key={c.id} className="group flex items-center rounded-lg hover:bg-sidebar-accent">
            <Button
              variant={c.id === conversationId ? "secondary" : "ghost"}
              className="min-w-0 flex-1 justify-start text-left font-normal"
              onClick={() => router.push(`/assistant?conversation=${c.id}`)}
            >
              <MessageSquare className="size-4 shrink-0" />
              <span className="truncate">
                {c.title ??
                  `${c.dealId ? "Deal chat" : "Workspace chat"} · ${new Date(c.createdAt).toLocaleDateString()}`}
              </span>
            </Button>
            {c.title && (
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0 opacity-0 group-hover:opacity-100"
                aria-label={`Manage ${c.title}`}
                onClick={() => {
                  setEditing(c)
                  setTitle(c.title ?? "")
                }}
              >
                <Pencil className="size-3" />
              </Button>
            )}
          </div>
        ))}
        {nextBefore && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() =>
              void assistantJson<{
                conversations: History[]
                nextBefore: string | null
              }>(
                `/api/mca/assistant/conversations?before=${encodeURIComponent(nextBefore)}&q=${encodeURIComponent(historyQuery)}`
              )
                .then((d) => {
                  setHistory((h) => [...h, ...d.conversations])
                  setNextBefore(d.nextBefore)
                })
                .catch((e) => setError(e.message))
            }
          >
            Load more conversations
          </Button>
        )}
      </nav>
    </aside>
  )
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {error && (
        <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2 border-b p-2 lg:hidden">
        <Button
          variant="outline"
          className="flex-1"
          aria-expanded={showNavigation}
          onClick={() => setShowNavigation((s) => !s)}
        >
          <MessageSquare className="size-4" />
          Chats and deal context
        </Button>
        <Button aria-label="New chat" disabled={creating} onClick={() => void create()}>
          <Plus className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={`${showNavigation ? "block" : "hidden"} min-h-0 w-full lg:block lg:w-auto`}>
          {rail}
        </div>
        <main className="min-h-0 min-w-0 flex-1">
          {conversationId ? (
            <DealAssistant
              key={conversationId}
              conversationId={conversationId}
              standalone
              onChanged={refresh}
            />
          ) : (
            <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-4 text-center">
              <Bot className="mb-4 size-10 text-primary" />
              <h1 className="text-2xl font-semibold tracking-tight">What would you like to work on?</h1>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                Ask a question, work through a deal, or plan follow-ups onto your calendar.
                Choose an optional deal on the left, then start chatting.
              </p>
              <div className="mt-6 flex w-full flex-wrap justify-center gap-2">
                {starters.map((prompt) => (
                  <Button
                    key={prompt}
                    variant="outline"
                    size="sm"
                    disabled={creating}
                    onClick={() => void create(prompt)}
                  >
                    {prompt}
                  </Button>
                ))}
              </div>
              <form
                className="mt-6 w-full rounded-3xl border bg-background p-2 shadow-sm"
                onSubmit={(e) => {
                  e.preventDefault()
                  void create(draft)
                }}
              >
                <Textarea
                  aria-label="Ask the assistant"
                  placeholder="Ask anything, or tell me what to work on…"
                  value={draft}
                  maxLength={8000}
                  rows={3}
                  className="min-h-16 resize-none border-0 shadow-none focus-visible:ring-0"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void create(draft)
                    }
                  }}
                />
                <div className="flex justify-end">
                  <Button type="submit" disabled={creating || !draft.trim()}>
                    Start chatting
                  </Button>
                </div>
              </form>
            </div>
          )}
        </main>
      </div>
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(o) => {
          if (!o) setEditing(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manage conversation</DialogTitle>
            <DialogDescription>
              Rename this private chat or delete its history and files. Existing
              business actions stay in the deal records.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void manage()
            }}
          >
            <label htmlFor="chat-title" className="text-sm">
              Conversation name
            </label>
            <Input
              id="chat-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
            />
            <div className="flex justify-between">
              <Button
                type="button"
                variant="destructive"
                disabled={saving}
                onClick={() => void manage(true)}
              >
                <Trash2 className="size-4" />
                Delete chat
              </Button>
              <Button type="submit" disabled={saving || !title.trim()}>
                Save name
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
