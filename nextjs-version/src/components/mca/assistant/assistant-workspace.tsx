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
import { DealAssistant } from "./deal-assistant"
import { assistantJson, CreditBalanceBadge } from "./credit-balance"
import type { ConversationView } from "@/lib/mca/assistant/contracts"
type History = {
  id: string
  dealId: string | null
  createdAt: string
  title?: string
}
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
  async function create() {
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
      router.push(`/assistant?conversation=${c.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create a chat.")
    } finally {
      setCreating(false)
    }
  }
  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center gap-3">
          <Bot className="size-7 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">
            AI Assistant
          </h1>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          A place to think, create, and get work done.
        </p>
        <div className="mt-4">
          <CreditBalanceBadge />
        </div>
      </header>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2 lg:hidden">
        <Button
          variant="outline"
          className="flex-1"
          aria-expanded={showNavigation}
          onClick={() => setShowNavigation((s) => !s)}
        >
          <MessageSquare className="size-4" />
          Chats and deal context
        </Button>
        <Button
          aria-label="New chat"
          disabled={creating}
          onClick={() => void create()}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside
          className={`${showNavigation ? "block" : "hidden"} min-w-0 space-y-3 lg:block`}
        >
          <label
            htmlFor="assistant-deal-search"
            className="block text-xs font-medium"
          >
            Find a deal (optional)
          </label>
          <input
            id="assistant-deal-search"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Search business name"
            value={dealQuery}
            onChange={(e) => {
              setDealQuery(e.target.value)
              setSelectedDeal("")
            }}
          />
          <label
            htmlFor="assistant-deal-context"
            className="block text-xs font-medium"
          >
            Conversation context
          </label>
          <select
            id="assistant-deal-context"
            className="w-full rounded-md border bg-background p-2 text-sm"
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
          <Button
            className="w-full"
            onClick={() => void create()}
            disabled={creating}
          >
            <Plus className="size-4" />
            New conversation
          </Button>
          <nav
            aria-label="Assistant chat history"
            className="flex gap-2 overflow-x-auto lg:max-h-[65vh] lg:flex-col lg:overflow-y-auto"
          >
            <div className="relative min-w-48 lg:min-w-0">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
              <input
                aria-label="Search conversations"
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                maxLength={200}
                placeholder="Search conversations"
                className="w-full rounded-md border bg-background py-2 pl-8 pr-2 text-xs"
              />
            </div>
            {history.map((c) => (
              <div
                key={c.id}
                className="group flex shrink-0 items-center rounded-md hover:bg-muted/50"
              >
                <Button
                  variant={c.id === conversationId ? "secondary" : "ghost"}
                  className="min-w-0 flex-1 justify-start text-left"
                  onClick={() => router.push(`/assistant?conversation=${c.id}`)}
                >
                  <MessageSquare className="size-4" />
                  <span className="truncate">
                    {c.title ??
                      `${c.dealId ? "Deal chat" : "Workspace chat"} · ${new Date(c.createdAt).toLocaleDateString()}`}
                  </span>
                </Button>
                {c.title && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0"
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
        <main className="min-w-0">
          {conversationId ? (
            <DealAssistant
              key={conversationId}
              conversationId={conversationId}
              standalone
              onChanged={refresh}
            />
          ) : (
            <div className="flex min-h-[45vh] flex-col items-center justify-center rounded-xl border bg-muted/20 p-6 text-center">
              <Bot className="mb-4 size-10 text-primary" />
              <h2 className="text-lg font-medium">
                What would you like to work on?
              </h2>
              <p className="my-3 max-w-md text-sm text-muted-foreground">
                Ask a question, work through an idea, or get help with a deal.
                Choose an optional deal on the left, then start chatting.
              </p>
              <Button onClick={() => void create()} disabled={creating}>
                Start a conversation
              </Button>
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
            <input
              id="chat-title"
              className="w-full rounded-md border bg-background p-2"
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
