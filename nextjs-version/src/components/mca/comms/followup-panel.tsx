"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, LoaderCircle, Mail, MessageSquareText, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RequestError, requestJson } from "@/lib/mca/client"

type Channel = "email" | "sms"
type Frequency = "daily" | "weekly" | "monthly"
type DealStatus =
  | "lead"
  | "new_application"
  | "missing_documents"
  | "ready_to_submit"
  | "submitted"
  | "resubmitting"
  | "offer"
  | "repricing"
  | "contract"
  | "funded"
  | "renewed"
  | "closed"
  | "default"
  | "missed_payments"

type LocalSchedule = {
  timezone: string
  frequency: Frequency
  hour: number
  minute: number
  weekday?: number
  dayOfMonth?: number
}

type RetryPolicy = { maxAttempts: number; backoffMinutes: number }

type PolicyView = {
  id: string
  dealStatus: DealStatus
  channel: Channel
  localSchedule: LocalSchedule
  templateId: string
  templateName: string | null
  templatePublished: boolean
  enabled: boolean
  retryPolicy: RetryPolicy
  lastOccurrence?: { id: string; state: string; skipReason?: string; occurrenceKey: string }
}

type TemplateOption = { id: string; name: string; channel: Channel; scope: string; published: boolean }

type Catalog = {
  policies: PolicyView[]
  templates: TemplateOption[]
  defaultTimezone: string
  statuses: Array<{ value: DealStatus; label: string }>
  canManage: boolean
}

type PreviewDeal = {
  dealId: string
  displayId: string
  legalName: string
  status: string
  recipient?: string
  wouldSend: boolean
  reason?: string
}

type PreviewPayload = {
  mode: "preview"
  policy: PolicyView
  window?: { occurrenceKey: string; scheduledFor: string; due: boolean; localDate: string }
  deals: PreviewDeal[]
  rendered?: { dealId: string; to: string; subject?: string; text: string }
}

export const FOLLOWUP_PANEL_COPY = {
  loading: "Loading follow-up policies…",
  empty: "No follow-up policies yet. Create one to email or text merchants in a deal status on a schedule.",
  statusRequired: "Choose a deal status.",
  channelRequired: "Choose email or SMS.",
  timezoneInvalid: "Choose a valid IANA timezone.",
  templateRequired: "Choose a published template.",
  weekdayRequired: "Choose a weekday for weekly follow-ups.",
  dayRequired: "Choose a day of the month for monthly follow-ups.",
  saved: "Follow-up policy saved.",
  enabled: "Follow-up policy enabled.",
  paused: "Follow-up policy paused.",
  failed: "The follow-up policy could not be saved.",
  previewFailed: "This follow-up could not be previewed.",
  testSent: "Test follow-up delivered in preview mode.",
  testFailed: "The test follow-up could not be sent.",
  previewEmpty: "No matching deals in this status for the current schedule.",
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof RequestError) {
    const fields = caught.fieldErrors ? Object.values(caught.fieldErrors).flat().filter(Boolean) : []
    if (fields.length) return fields.join(" ")
    return caught.message
  }
  return caught instanceof Error ? caught.message : fallback
}

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM"
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}:00 ${suffix}`
}

export function followupPanelGate(input: {
  loading: boolean
  policies: PolicyView[]
  dealStatus: string
  templateId: string
  timezone: string
  frequency: Frequency
  weekday?: number
  dayOfMonth?: number
}): { phase: "loading" | "empty" | "validation" | "ready"; saveEnabled: boolean; reason: string } {
  if (input.loading) return { phase: "loading", saveEnabled: false, reason: FOLLOWUP_PANEL_COPY.loading }
  if (!input.policies.length && !input.dealStatus && !input.templateId) {
    return { phase: "empty", saveEnabled: false, reason: FOLLOWUP_PANEL_COPY.empty }
  }
  if (!input.dealStatus) return { phase: "validation", saveEnabled: false, reason: FOLLOWUP_PANEL_COPY.statusRequired }
  if (!input.templateId) return { phase: "validation", saveEnabled: false, reason: FOLLOWUP_PANEL_COPY.templateRequired }
  if (!input.timezone.trim()) return { phase: "validation", saveEnabled: false, reason: FOLLOWUP_PANEL_COPY.timezoneInvalid }
  if (input.frequency === "weekly" && (input.weekday == null || input.weekday < 0)) {
    return { phase: "validation", saveEnabled: false, reason: FOLLOWUP_PANEL_COPY.weekdayRequired }
  }
  if (input.frequency === "monthly" && !input.dayOfMonth) {
    return { phase: "validation", saveEnabled: false, reason: FOLLOWUP_PANEL_COPY.dayRequired }
  }
  return { phase: "ready", saveEnabled: true, reason: "Ready to save this follow-up policy." }
}

export function FollowupPanel() {
  const [catalog, setCatalog] = React.useState<Catalog>()
  const [selectedId, setSelectedId] = React.useState<string>()
  const [dealStatus, setDealStatus] = React.useState<DealStatus | "">("")
  const [channel, setChannel] = React.useState<Channel>("email")
  const [timezone, setTimezone] = React.useState("")
  const [frequency, setFrequency] = React.useState<Frequency>("daily")
  const [hour, setHour] = React.useState(9)
  const [weekday, setWeekday] = React.useState(1)
  const [dayOfMonth, setDayOfMonth] = React.useState(1)
  const [templateId, setTemplateId] = React.useState("")
  const [enabled, setEnabled] = React.useState(true)
  const [maxAttempts, setMaxAttempts] = React.useState(3)
  const [backoffMinutes, setBackoffMinutes] = React.useState(15)
  const [previewDealId, setPreviewDealId] = React.useState("")
  const [preview, setPreview] = React.useState<PreviewPayload>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<"save" | "preview" | "test">()
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()

  const templates = (catalog?.templates ?? []).filter((item) => item.channel === channel)
  const gate = followupPanelGate({
    loading,
    policies: catalog?.policies ?? [],
    dealStatus,
    templateId,
    timezone,
    frequency,
    weekday,
    dayOfMonth,
  })

  const applyPolicy = React.useCallback((policy: PolicyView, defaults: string) => {
    setSelectedId(policy.id)
    setDealStatus(policy.dealStatus)
    setChannel(policy.channel)
    setTimezone(policy.localSchedule.timezone || defaults)
    setFrequency(policy.localSchedule.frequency)
    setHour(policy.localSchedule.hour)
    setWeekday(policy.localSchedule.weekday ?? 1)
    setDayOfMonth(policy.localSchedule.dayOfMonth ?? 1)
    setTemplateId(policy.templateId)
    setEnabled(policy.enabled)
    setMaxAttempts(policy.retryPolicy.maxAttempts)
    setBackoffMinutes(policy.retryPolicy.backoffMinutes)
  }, [])

  const resetComposer = React.useCallback((defaults?: string) => {
    setSelectedId(undefined)
    setDealStatus("")
    setChannel("email")
    setTimezone(defaults ?? catalog?.defaultTimezone ?? "")
    setFrequency("daily")
    setHour(9)
    setWeekday(1)
    setDayOfMonth(1)
    setTemplateId("")
    setEnabled(true)
    setMaxAttempts(3)
    setBackoffMinutes(15)
    setPreview(undefined)
    setPreviewDealId("")
  }, [catalog?.defaultTimezone])

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<Catalog>("/api/mca/comms/followups")
      setCatalog(next)
      setTimezone((current) => current || next.defaultTimezone)
    } catch (caught) {
      setError(errorMessage(caught, FOLLOWUP_PANEL_COPY.failed))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  function schedulePayload(): LocalSchedule {
    return {
      timezone: timezone.trim(),
      frequency,
      hour,
      minute: 0,
      ...(frequency === "weekly" ? { weekday } : {}),
      ...(frequency === "monthly" ? { dayOfMonth } : {}),
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy("save")
    setError(undefined)
    setMessage(undefined)
    if (!gate.saveEnabled) {
      setError(gate.reason)
      setBusy(undefined)
      return
    }
    try {
      const body = {
        dealStatus,
        channel,
        localSchedule: schedulePayload(),
        templateId,
        enabled,
        retryPolicy: { maxAttempts, backoffMinutes },
      }
      const saved = selectedId
        ? await requestJson<PolicyView>(`/api/mca/comms/followups/${selectedId}`, { method: "PATCH", body: JSON.stringify(body) })
        : await requestJson<PolicyView>("/api/mca/comms/followups", { method: "POST", body: JSON.stringify(body) })
      const next = await requestJson<Catalog>("/api/mca/comms/followups")
      setCatalog(next)
      applyPolicy(saved, next.defaultTimezone)
      setMessage(saved.enabled ? (selectedId ? FOLLOWUP_PANEL_COPY.saved : FOLLOWUP_PANEL_COPY.enabled) : FOLLOWUP_PANEL_COPY.paused)
    } catch (caught) {
      setError(errorMessage(caught, FOLLOWUP_PANEL_COPY.failed))
    } finally {
      setBusy(undefined)
    }
  }

  async function runPreview() {
    if (!selectedId) {
      setError("Save the follow-up policy before previewing matching deals.")
      return
    }
    setBusy("preview")
    setError(undefined)
    setMessage(undefined)
    try {
      const query = new URLSearchParams({ policyId: selectedId })
      if (previewDealId.trim()) query.set("dealId", previewDealId.trim())
      const next = await requestJson<PreviewPayload>(`/api/mca/comms/followups/preview?${query.toString()}`)
      setPreview(next)
      setMessage(next.deals.length ? `Preview ready for ${next.deals.length} deal${next.deals.length === 1 ? "" : "s"}.` : FOLLOWUP_PANEL_COPY.previewEmpty)
    } catch (caught) {
      setError(errorMessage(caught, FOLLOWUP_PANEL_COPY.previewFailed))
    } finally {
      setBusy(undefined)
    }
  }

  async function runTest() {
    if (!selectedId || !previewDealId.trim()) {
      setError("Enter a deal id to send a test follow-up.")
      return
    }
    setBusy("test")
    setError(undefined)
    setMessage(undefined)
    try {
      const result = await requestJson<{ wouldSend: boolean; delivery?: string; reason?: string }>(
        `/api/mca/comms/followups/${selectedId}/test`,
        { method: "POST", body: JSON.stringify({ dealId: previewDealId.trim() }) },
      )
      if (result.wouldSend) setMessage(FOLLOWUP_PANEL_COPY.testSent)
      else setError(result.reason === "send_failed" ? FOLLOWUP_PANEL_COPY.testFailed : `Test skipped: ${result.reason ?? "not eligible"}.`)
    } catch (caught) {
      setError(errorMessage(caught, FOLLOWUP_PANEL_COPY.testFailed))
    } finally {
      setBusy(undefined)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-56 items-center justify-center rounded-xl border text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 size-5 animate-spin" /> {FOLLOWUP_PANEL_COPY.loading}
      </div>
    )
  }

  const empty = !catalog?.policies.length && !selectedId

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4" /> Scheduled merchant follow-ups
        </CardTitle>
        <CardDescription>
          Email or text merchants who stay in a deal status. Status, consent, and recipient are rechecked immediately before each send.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-5">
          {error ? (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
          {message ? (
            <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              <span>{message}</span>
            </div>
          ) : null}

          {empty ? (
            <p className="text-sm text-muted-foreground">{FOLLOWUP_PANEL_COPY.empty}</p>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
            <div className="space-y-2">
              <Button type="button" variant="outline" size="sm" onClick={() => resetComposer()} disabled={Boolean(busy)}>
                <Plus className="size-4" />
                New follow-up
              </Button>
              {!catalog?.policies.length ? null : (
                <ul className="space-y-1">
                  {catalog.policies.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`w-full rounded-md border px-2 py-1.5 text-left text-sm ${selectedId === item.id ? "border-primary bg-muted" : ""}`}
                        onClick={() => applyPolicy(item, catalog.defaultTimezone)}
                        disabled={Boolean(busy)}
                      >
                        <span className="block font-medium">{item.templateName || item.dealStatus}</span>
                        <span className="text-xs text-muted-foreground">
                          {item.channel} · {item.dealStatus.replaceAll("_", " ")} · {item.enabled ? "on" : "paused"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="followup-status">Deal status</Label>
                  <select
                    id="followup-status"
                    aria-label="Deal status"
                    className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={dealStatus}
                    onChange={(event) => setDealStatus(event.target.value as DealStatus)}
                    disabled={Boolean(busy)}
                  >
                    <option value="">Choose a deal status</option>
                    {(catalog?.statuses ?? []).map((status) => (
                      <option key={status.value} value={status.value}>{status.label}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="followup-channel">Channel</Label>
                  <select
                    id="followup-channel"
                    aria-label="Follow-up channel"
                    className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={channel}
                    onChange={(event) => {
                      const next = event.target.value as Channel
                      setChannel(next)
                      if (templateId && !templates.some((item) => item.id === templateId && item.channel === next)) setTemplateId("")
                    }}
                    disabled={Boolean(busy)}
                  >
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="followup-template">Template</Label>
                  <select
                    id="followup-template"
                    aria-label="Published template"
                    className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={templateId}
                    onChange={(event) => setTemplateId(event.target.value)}
                    disabled={Boolean(busy)}
                  >
                    <option value="">Choose a published template</option>
                    {templates.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="followup-frequency">Schedule</Label>
                  <select
                    id="followup-frequency"
                    aria-label="Follow-up frequency"
                    className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={frequency}
                    onChange={(event) => setFrequency(event.target.value as Frequency)}
                    disabled={Boolean(busy)}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="followup-timezone">Timezone</Label>
                  <Input
                    id="followup-timezone"
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    placeholder={catalog?.defaultTimezone ?? "America/New_York"}
                    disabled={Boolean(busy)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="followup-hour">Local send hour</Label>
                  <select
                    id="followup-hour"
                    aria-label="Local send hour"
                    className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={hour}
                    onChange={(event) => setHour(Number(event.target.value))}
                    disabled={Boolean(busy)}
                  >
                    {Array.from({ length: 24 }, (_, value) => (
                      <option key={value} value={value}>{hourLabel(value)}</option>
                    ))}
                  </select>
                </div>
                {frequency === "weekly" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="followup-weekday">Weekday</Label>
                    <select
                      id="followup-weekday"
                      aria-label="Weekday"
                      className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                      value={weekday}
                      onChange={(event) => setWeekday(Number(event.target.value))}
                      disabled={Boolean(busy)}
                    >
                      {WEEKDAYS.map((label, value) => (
                        <option key={label} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {frequency === "monthly" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="followup-day">Day of month</Label>
                    <Input
                      id="followup-day"
                      type="number"
                      min={1}
                      max={31}
                      value={dayOfMonth}
                      onChange={(event) => setDayOfMonth(Number(event.target.value))}
                      disabled={Boolean(busy)}
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <Label htmlFor="followup-attempts">Retry attempts</Label>
                  <Input
                    id="followup-attempts"
                    type="number"
                    min={1}
                    max={10}
                    value={maxAttempts}
                    onChange={(event) => setMaxAttempts(Number(event.target.value))}
                    disabled={Boolean(busy)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="followup-backoff">Retry backoff (minutes)</Label>
                  <Input
                    id="followup-backoff"
                    type="number"
                    min={1}
                    max={1440}
                    value={backoffMinutes}
                    onChange={(event) => setBackoffMinutes(Number(event.target.value))}
                    disabled={Boolean(busy)}
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Checkbox
                  id="followup-enabled"
                  checked={enabled}
                  onCheckedChange={(value) => setEnabled(value === true)}
                  disabled={Boolean(busy)}
                />
                <Label htmlFor="followup-enabled">{enabled ? "Enabled" : "Paused"}</Label>
                {channel === "sms" ? <Badge variant="outline"><MessageSquareText className="mr-1 size-3" /> SMS consent required</Badge> : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                <div className="space-y-1.5">
                  <Label htmlFor="followup-deal">Test / preview deal id</Label>
                  <Input
                    id="followup-deal"
                    value={previewDealId}
                    onChange={(event) => setPreviewDealId(event.target.value)}
                    placeholder="Optional deal id"
                    disabled={Boolean(busy)}
                  />
                </div>
                <Button type="button" variant="outline" className="self-end" onClick={() => void runPreview()} disabled={Boolean(busy) || !selectedId}>
                  {busy === "preview" ? <LoaderCircle className="animate-spin" /> : null}
                  Preview
                </Button>
                <Button type="button" variant="outline" className="self-end" onClick={() => void runTest()} disabled={Boolean(busy) || !selectedId}>
                  {busy === "test" ? <LoaderCircle className="animate-spin" /> : null}
                  Send test
                </Button>
              </div>

              {preview ? (
                <div className="space-y-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    Current occurrence
                    <Badge variant="outline">{preview.window?.due ? "Due" : "Not due"}</Badge>
                    {preview.window ? <span className="text-xs text-muted-foreground">{preview.window.occurrenceKey}</span> : null}
                  </div>
                  {!preview.deals.length ? (
                    <p className="text-sm text-muted-foreground">{FOLLOWUP_PANEL_COPY.previewEmpty}</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {preview.deals.map((deal) => (
                        <li key={deal.dealId}>
                          {deal.displayId} · {deal.legalName} · {deal.wouldSend ? `send to ${deal.recipient}` : `skip ${deal.reason}`}
                        </li>
                      ))}
                    </ul>
                  )}
                  {preview.rendered ? (
                    <pre className="overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{preview.rendered.subject ? `${preview.rendered.subject}\n\n` : ""}{preview.rendered.text}</pre>
                  ) : null}
                </div>
              ) : null}

              <Button type="submit" disabled={Boolean(busy) || !gate.saveEnabled}>
                {busy === "save" ? <LoaderCircle className="animate-spin" /> : null}
                {busy === "save" ? "Saving" : selectedId ? "Save follow-up policy" : "Create follow-up policy"}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
