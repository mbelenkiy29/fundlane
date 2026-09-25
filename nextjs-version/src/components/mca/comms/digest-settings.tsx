"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, LoaderCircle, Mail } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RequestError, requestJson } from "@/lib/mca/client"

type DigestStage = "new" | "submitted" | "approved" | "funded"

type DigestDealItem = {
  dealId: string
  displayId: string
  legalName: string
  href: string
  occurredAt: string
}

type DigestPayload = {
  window: { windowStart: string; windowEnd: string; timezone: string; localSendHour: number; due: boolean }
  groups: Array<{ stage: DigestStage; deals: DigestDealItem[] }>
  empty: boolean
}

type DigestSettingsPayload = {
  membershipId: string
  enabled: boolean
  timezone: string
  localSendHour: number
  defaultTimezone: string
  defaultLocalSendHour: number
  preview: DigestPayload
  lastDelivery?: {
    id: string
    windowStart: string
    windowEnd: string
    state: "sent" | "skipped" | "failed"
    createdAt: string
    correlationId: string
  }
}

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

function stageLabel(stage: DigestStage): string {
  if (stage === "new") return "New"
  if (stage === "submitted") return "Submitted"
  if (stage === "approved") return "Approved"
  return "Funded"
}

export function DigestSettings() {
  const [payload, setPayload] = React.useState<DigestSettingsPayload>()
  const [enabled, setEnabled] = React.useState(false)
  const [timezone, setTimezone] = React.useState("")
  const [localSendHour, setLocalSendHour] = React.useState(6)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<DigestSettingsPayload>("/api/mca/comms/digest")
      setPayload(next)
      setEnabled(next.enabled)
      setTimezone(next.timezone)
      setLocalSendHour(next.localSendHour)
    } catch (caught) {
      setError(errorMessage(caught, "Daily digest settings could not be loaded."))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(undefined)
    setMessage(undefined)
    if (!timezone.trim()) {
      setSaving(false)
      setError("Choose a valid IANA timezone.")
      return
    }
    try {
      const next = await requestJson<DigestSettingsPayload>("/api/mca/comms/digest", {
        method: "PATCH",
        body: JSON.stringify({ enabled, timezone: timezone.trim(), localSendHour }),
      })
      setPayload(next)
      setEnabled(next.enabled)
      setTimezone(next.timezone)
      setLocalSendHour(next.localSendHour)
      setMessage(
        next.enabled
          ? `Daily digest enabled. Emails send at ${hourLabel(next.localSendHour)} in ${next.timezone}.`
          : "Daily digest is off.",
      )
    } catch (caught) {
      setError(errorMessage(caught, "Daily digest settings could not be saved."))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-56 items-center justify-center rounded-xl border text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 size-5 animate-spin" /> Loading digest settings
      </div>
    )
  }

  const preview = payload?.preview
  const empty = !payload?.enabled

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4" /> Daily deal activity digest
        </CardTitle>
        <CardDescription>
          Opt in to a daily report email at a set local time. Content is role-appropriate: administrators see workspace-wide activity, and other roles see only deals they can access.
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
            <p className="text-sm text-muted-foreground">
              Daily digest is off. Enable it to receive new, submitted, approved, and funded deals from the previous 24 hours.
            </p>
          ) : null}

          <div className="flex items-start gap-3">
            <Checkbox
              id="digest-enabled"
              checked={enabled}
              onCheckedChange={(value) => setEnabled(value === true)}
            />
            <div className="space-y-1">
              <Label htmlFor="digest-enabled">Enable daily reports</Label>
              <p className="text-sm text-muted-foreground">
                Emails use actual pipeline event times, not later edits. A deal funded three days ago does not appear because it was edited today. Each recipient gets role-appropriate content for their deal visibility.
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="digest-timezone">Timezone</Label>
              <Input
                id="digest-timezone"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                placeholder={payload?.defaultTimezone ?? "America/New_York"}
              />
              <p className="text-xs text-muted-foreground">Defaults to the workspace timezone ({payload?.defaultTimezone}).</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="digest-hour">Send hour</Label>
              <Select value={String(localSendHour)} onValueChange={(value) => setLocalSendHour(Number(value))}>
                <SelectTrigger id="digest-hour" className="w-full">
                  <SelectValue placeholder="Choose an hour" />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, hour) => (
                    <SelectItem key={hour} value={String(hour)}>
                      {hourLabel(hour)}{hour === (payload?.defaultLocalSendHour ?? 6) ? " (workspace default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {preview ? (
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                Current window
                <Badge variant="outline">{preview.empty ? "No deal activity in the current digest window." : "Activity ready"}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {preview.window.windowStart} → {preview.window.windowEnd} ({preview.window.timezone})
              </p>
              <ul className="grid gap-1 text-sm sm:grid-cols-2">
                {preview.groups.map((group) => (
                  <li key={group.stage}>{stageLabel(group.stage)}: {group.deals.length}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {payload?.lastDelivery ? (
            <p className="text-xs text-muted-foreground">
              Last delivery {payload.lastDelivery.state} at {payload.lastDelivery.createdAt}.
            </p>
          ) : null}

          <Button type="submit" disabled={saving}>
            {saving ? <LoaderCircle className="animate-spin" /> : null}
            {saving ? "Saving" : "Save digest settings"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
