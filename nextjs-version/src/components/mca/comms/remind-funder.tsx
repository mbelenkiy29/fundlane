"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Loader2, Mail, Reply } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RequestError, requestJson } from "@/lib/mca/client"
import { reminderSendGate } from "@/lib/mca/integrations/connection-status"
import { MissingPrerequisites } from "@/components/mca/integrations/connection-status"

type ReminderIneligibleReason = "unsupported_transport" | "not_sent" | "has_response" | "delivery_unconfigured"
type ReminderThreadMode = "reply" | "fallback"
type RouteKind = "email" | "api" | "manual_portal" | "custom_webhook"

type ReminderJobView = {
  jobId: string
  dealId: string
  funderId: string
  displayFunderName: string
  routeKind: RouteKind
  submissionState: string
  eligible: boolean
  remindControl: "remind" | "hidden"
  ineligibleReason?: ReminderIneligibleReason
  lastRemindedAt?: string
  lastReminderId?: string
  lastReminderState?: "previewed" | "sent" | "failed"
}

type ListPayload = {
  dealId: string
  canSend: boolean
  defaultBody: string
  jobs: ReminderJobView[]
}

type PreviewPayload = {
  reminderId: string
  jobId: string
  dealId: string
  funderId: string
  displayFunderName: string
  submissionState: string
  sender: { id: string; fromName: string; fromAddress: string }
  to: string[]
  cc: string[]
  replyTo: string
  subject: string
  body: string
  defaultBody: string
  thread: {
    mode: ReminderThreadMode
    messageId?: string
    threadId?: string
    inReplyTo?: string
    references: string[]
    disclosure?: string
  }
  lastRemindedAt?: string
  canSend: boolean
  delivery: "preview"
}

type SendPayload = {
  reminderId: string
  jobId: string
  submissionState: string
  state: "sent" | "failed"
  lastRemindedAt?: string
  delivery: "sent" | "preview" | "failed"
  correlationId: string
  error?: string
}

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof RequestError) {
    const fields = caught.fieldErrors ? Object.values(caught.fieldErrors).flat().filter(Boolean) : []
    if (fields.length) return fields.join(" ")
    return caught.message
  }
  return caught instanceof Error ? caught.message : fallback
}

function formatTimestamp(value?: string): string {
  if (!value) return "Never"
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Date(parsed).toLocaleString()
}

export function ReminderDeliveryUnavailable({ jobs }: { jobs: ReminderJobView[] }) {
  const unavailable = jobs.filter((job) => job.ineligibleReason === "delivery_unconfigured")
  if (!unavailable.length) return null
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Reminder delivery is unavailable for {unavailable.map((job) => job.displayFunderName).join(", ")}. Contact your administrator to configure reminder delivery.
    </p>
  )
}

export function RemindFunder({ dealId }: { dealId: string }) {
  const [payload, setPayload] = React.useState<ListPayload>()
  const [preview, setPreview] = React.useState<PreviewPayload>()
  const [body, setBody] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<"preview" | "send">()
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<ListPayload>(`/api/mca/comms/reminders?dealId=${encodeURIComponent(dealId)}`)
      setPayload(next)
    } catch (caught) {
      setError(errorMessage(caught, "Funder reminders could not be loaded."))
    } finally {
      setLoading(false)
    }
  }, [dealId])

  React.useEffect(() => { void load() }, [load])

  const eligible = payload?.jobs.filter((job) => job.eligible && job.remindControl === "remind") ?? []
  const sendGate = preview ? reminderSendGate({ canSend: preview.canSend, body }) : { enabled: false, missing: [] }

  async function openPreview(job: ReminderJobView) {
    setBusy("preview")
    setError(undefined)
    setMessage(undefined)
    try {
      const next = await requestJson<PreviewPayload>("/api/mca/comms/reminders/preview", {
        method: "POST",
        body: JSON.stringify({ jobId: job.jobId }),
      })
      setPreview(next)
      setBody(next.body)
    } catch (caught) {
      setError(errorMessage(caught, "This reminder could not be previewed."))
    } finally {
      setBusy(undefined)
    }
  }

  async function send() {
    if (!preview) return
    if (!body.trim()) {
      setError("Enter reminder text.")
      return
    }
    setBusy("send")
    setError(undefined)
    setMessage(undefined)
    try {
      const result = await requestJson<SendPayload>("/api/mca/comms/reminders", {
        method: "POST",
        body: JSON.stringify({ jobId: preview.jobId, reminderId: preview.reminderId, body }),
      })
      if (result.state !== "sent") {
        setPreview((current) => current ? { ...current, reminderId: result.reminderId } : current)
        setError(result.error ?? "The reminder could not be sent.")
        return
      }
      setMessage("Reminder sent. Submission status is unchanged.")
      setPreview(undefined)
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "The reminder could not be sent."))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Reply className="size-5" />Remind funder</CardTitle>
          <CardDescription>
            Nudge unanswered email submissions in the original thread. API, portal, and webhook jobs have no reminder control.
          </CardDescription>
        </div>
        <Button onClick={() => void load()} disabled={loading || Boolean(busy)} variant="outline" aria-label="Refresh funder reminders">
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading funder reminders…</p>}
        {error && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</p>}
        {message && <p role="status" className="flex items-start gap-2 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{message}</p>}
        {!loading && !error && !preview && <ReminderDeliveryUnavailable jobs={payload?.jobs ?? []} />}

        {!loading && !error && eligible.length === 0 && !preview && !payload?.jobs.some((job) => job.ineligibleReason === "delivery_unconfigured") && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No unanswered email submissions are ready to remind.
          </div>
        )}

        {eligible.length > 0 && !preview && (
          <ul className="space-y-3">
            {eligible.map((job) => (
              <li key={job.jobId} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{job.displayFunderName}</p>
                  <Badge variant="outline">Email</Badge>
                  <Badge variant="secondary">{job.submissionState.replaceAll("_", " ")}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">Last reminded {formatTimestamp(job.lastRemindedAt)}</p>
                <Button
                  onClick={() => void openPreview(job)}
                  disabled={Boolean(busy)}
                  aria-label={`Remind ${job.displayFunderName}`}
                >
                  {busy === "preview" ? <Loader2 className="size-4 animate-spin" /> : <Reply className="size-4" />}
                  Remind Funder
                </Button>
              </li>
            ))}
          </ul>
        )}

        {preview && (
          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{preview.displayFunderName}</p>
              <Badge variant="outline">{preview.thread.mode === "reply" ? "Original thread" : "New email"}</Badge>
            </div>
            {preview.thread.mode === "fallback" && preview.thread.disclosure && (
              <p role="status" className="text-sm text-amber-800">{preview.thread.disclosure}</p>
            )}
            <dl className="grid gap-1 text-sm">
              <div><span className="text-muted-foreground">From</span> · {preview.sender.fromName} &lt;{preview.sender.fromAddress}&gt;</div>
              <div><span className="text-muted-foreground">To</span> · {preview.to.join(", ") || "—"}</div>
              <div><span className="text-muted-foreground">CC</span> · {preview.cc.join(", ") || "None"}</div>
              <div><span className="text-muted-foreground">Subject</span> · {preview.subject}</div>
            </dl>
            <div className="space-y-1.5">
              <Label htmlFor="funder-reminder-body">Reminder text</Label>
              <Textarea
                id="funder-reminder-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                disabled={Boolean(busy)}
                rows={6}
                aria-label="Reminder text"
              />
            </div>
            <MissingPrerequisites missing={sendGate.missing} />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void send()} disabled={!sendGate.enabled || Boolean(busy)} aria-label="Send funder reminder">
                {busy === "send" ? <Loader2 className="size-4 animate-spin" /> : <Reply className="size-4" />}
                {busy === "send" ? "Sending…" : "Send reminder"}
              </Button>
              <Button
                variant="outline"
                onClick={() => { setPreview(undefined); setBody("") }}
                disabled={Boolean(busy)}
                aria-label="Cancel reminder"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
