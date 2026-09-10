"use client"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { requestJson } from "@/lib/mca/client"
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
    [body, setBody] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [associate, setAssociate] = useState(""),
    [preview, setPreview] = useState<{
      canSend: boolean
      block?: { message: string }
    }>(),
    [retryKey, setRetryKey] = useState<string>()
  const load = useCallback(async () => {
    setThreads(
      (
        await requestJson<{ conversations: Thread[] }>(
          `/api/mca/sms/conversations${dealId ? `?dealId=${encodeURIComponent(dealId)}` : ""}`
        )
      ).conversations
    )
  }, [dealId])
  const open = useCallback(
    async (id: string) => {
      const d = await requestJson<Detail>(
        `/api/mca/sms/conversations?id=${encodeURIComponent(id)}`
      )
      setDetail(d)
      await requestJson("/api/mca/sms/conversations", {
        method: "POST",
        body: JSON.stringify({ id }),
      })
      await load()
    },
    [load]
  )
  useEffect(() => {
    void load().catch((e) => setError(e.message))
  }, [load])
  useEffect(() => {
    if (!selected) return
    let stopped = false
    const refresh = () => {
      if (!stopped) void open(selected).catch((e) => setError(e.message))
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
    const key = retryKey ?? crypto.randomUUID()
    setRetryKey(key)
    try {
      const result = await requestJson<{
        canSend: boolean
        block?: { message: string }
        state?: string
        errorMessage?: string
      }>("/api/mca/sms/messages", {
        method: "POST",
        body: JSON.stringify({
          dealId: detail.dealId,
          recipient: detail.recipient,
          body,
          senderAccountId: detail.accountId,
          idempotencyKey: key,
          preview: isPreview,
        }),
      })
      if (isPreview) setPreview(result)
      else {
        if (result.state !== "accepted")
          setError(
            result.errorMessage ??
              "Provider outcome is unknown. Refresh delivery status before sending again."
          )
        else {
          setBody("")
          setRetryKey(undefined)
          setPreview(undefined)
        }
        await open(detail.id)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Message failed")
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
            Employee numbers and authorized deals
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
              onClick={() => {
                setSelected(t.id)
                setBody("")
                setPreview(undefined)
                setRetryKey(undefined)
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
                    onChange={(e) => {
                      setBody(e.target.value)
                      setPreview(undefined)
                      setRetryKey(undefined)
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
