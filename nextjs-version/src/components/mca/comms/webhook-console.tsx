"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, LoaderCircle, RotateCcw, Trash2, Webhook } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RequestError, requestJson } from "@/lib/mca/client"

const EVENT_TYPES = [
  { id: "offer.created", label: "Offer created" },
  { id: "deal.transitioned", label: "Deal status updated" },
  { id: "deal.assigned", label: "Deal assigned" },
  { id: "submission.created", label: "Submission created" },
] as const

type EventType = (typeof EVENT_TYPES)[number]["id"]

type EndpointView = {
  id: string
  label: string
  destinationUrl: string
  destinationHost: string
  events: EventType[]
  notifyOriginator: boolean
  notifyCloser: boolean
  enabled: boolean
  signingSecretConfigured: boolean
  signingSecret?: string
  createdAt: string
  updatedAt: string
}

type OutboxView = {
  id: string
  endpointId: string
  endpointLabel?: string
  eventId: string
  eventType: EventType
  state: "pending" | "delivered" | "failed"
  attempts: number
  lastError?: string
  createdAt: string
  updatedAt: string
}

type DeliveryView = {
  id: string
  outboxId: string
  eventId: string
  eventType: EventType
  attempt: number
  httpStatus?: number
  state: "delivered" | "failed"
  error?: string
  createdAt: string
}

type ConsolePayload = {
  specVersion: string
  events: EventType[]
  endpoints: EndpointView[]
  outbox: OutboxView[]
  deliveries: DeliveryView[]
}

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof RequestError) {
    const fields = caught.fieldErrors ? Object.values(caught.fieldErrors).flat().filter(Boolean) : []
    if (fields.length) return fields.join(" ")
    return caught.message
  }
  return caught instanceof Error ? caught.message : fallback
}

function eventLabel(event: string): string {
  return EVENT_TYPES.find((item) => item.id === event)?.label ?? event
}

export function WebhookConsole() {
  const [payload, setPayload] = React.useState<ConsolePayload>()
  const [label, setLabel] = React.useState("")
  const [destinationUrl, setDestinationUrl] = React.useState("")
  const [events, setEvents] = React.useState<EventType[]>([])
  const [notifyOriginator, setNotifyOriginator] = React.useState(false)
  const [notifyCloser, setNotifyCloser] = React.useState(false)
  const [enabled, setEnabled] = React.useState(true)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const [shownSecret, setShownSecret] = React.useState<string>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<ConsolePayload>("/api/mca/comms/webhooks")
      setPayload(next)
    } catch (caught) {
      setError(errorMessage(caught, "Webhook console could not be loaded."))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  function toggleEvent(event: EventType, checked: boolean) {
    setEvents((current) => checked ? [...current, event] : current.filter((item) => item !== event))
  }

  async function save(formEvent: React.FormEvent) {
    formEvent.preventDefault()
    setSaving(true)
    setError(undefined)
    setMessage(undefined)
    if (!destinationUrl.trim() || (!destinationUrl.trim().startsWith("https://") && destinationUrl.trim() !== "mca://webhook/test")) {
      setSaving(false)
      setError("Enter a valid HTTPS webhook URL.")
      return
    }
    if (!events.length) {
      setSaving(false)
      setError("Choose at least one event.")
      return
    }
    try {
      const created = await requestJson<EndpointView>("/api/mca/comms/webhooks", {
        method: "POST",
        body: JSON.stringify({ label, destinationUrl: destinationUrl.trim(), events, notifyOriginator, notifyCloser, enabled }),
      })
      setShownSecret(created.signingSecret)
      setMessage("Webhook endpoint saved.")
      setLabel("")
      setDestinationUrl("")
      setEvents([])
      setNotifyOriginator(false)
      setNotifyCloser(false)
      setEnabled(true)
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "Webhook endpoint could not be saved."))
    } finally {
      setSaving(false)
    }
  }

  async function replay(outboxId: string) {
    setBusyId(outboxId)
    setError(undefined)
    setMessage(undefined)
    try {
      await requestJson(`/api/mca/comms/webhooks/outbox/${encodeURIComponent(outboxId)}/replay`, { method: "POST" })
      setMessage("Replay sent with the same event id.")
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "Webhook replay failed."))
    } finally {
      setBusyId(undefined)
    }
  }

  async function removeEndpoint(endpointId: string) {
    if (!window.confirm("Remove this webhook endpoint? Pending deliveries will fail. Historical deliveries stay in the log.")) {
      return
    }
    setBusyId(endpointId)
    setError(undefined)
    setMessage(undefined)
    try {
      await requestJson(`/api/mca/comms/webhooks/${encodeURIComponent(endpointId)}`, { method: "DELETE" })
      setMessage("Webhook endpoint removed.")
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "Webhook endpoint could not be removed."))
    } finally {
      setBusyId(undefined)
    }
  }

  async function testEndpoint(endpointId: string) {
    setBusyId(endpointId)
    setError(undefined)
    setMessage(undefined)
    try {
      const result = await requestJson<{ delivered: boolean; markedDelivered: false }>(
        `/api/mca/comms/webhooks/${encodeURIComponent(endpointId)}/test`,
        { method: "POST" },
      )
      setMessage(result.delivered
        ? "Webhook delivered. Test delivery does not mark workflow events delivered."
        : "Test delivery does not mark workflow events delivered.")
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "Webhook test failed."))
    } finally {
      setBusyId(undefined)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-56 items-center justify-center rounded-xl border text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 size-5 animate-spin" /> Loading webhook console
      </div>
    )
  }

  const empty = !payload?.endpoints.length

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Webhook className="size-4" /> Workflow webhooks
        </CardTitle>
        <CardDescription>
          Admins can add, test, and remove HTTPS destinations for offer-created and deal-status-updated events. Deliveries are signed, retried on failure, and listed in the delivery log. Replay preserves event identity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
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
        {shownSecret ? (
          <p className="rounded-md border px-3 py-2 text-sm">
            Signing secret is shown once. Store <code className="text-xs" data-sentry-block>{shownSecret}</code> for HMAC verification.
          </p>
        ) : null}

        {empty ? (
          <p className="text-sm text-muted-foreground">
            No webhook endpoints yet. Add an HTTPS URL and choose which workflow events to send.
          </p>
        ) : null}

        <form onSubmit={save} className="space-y-4 rounded-lg border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="webhook-label">Label</Label>
              <Input id="webhook-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Ops automation" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="webhook-url">Destination URL</Label>
              <Input
                id="webhook-url"
                value={destinationUrl}
                onChange={(event) => setDestinationUrl(event.target.value)}
                placeholder="https://hooks.example.com/workflow"
              />
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Events</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {EVENT_TYPES.map((event) => (
                <label key={event.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={events.includes(event.id)}
                    onCheckedChange={(value) => toggleEvent(event.id, value === true)}
                  />
                  {event.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={notifyOriginator} onCheckedChange={(value) => setNotifyOriginator(value === true)} />
              Notify originators
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={notifyCloser} onCheckedChange={(value) => setNotifyCloser(value === true)} />
              Notify closers
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
              Enabled
            </label>
          </div>
          <Button type="submit" disabled={saving}>
            {saving ? <LoaderCircle className="animate-spin" /> : null}
            {saving ? "Saving" : "Save webhook endpoint"}
          </Button>
        </form>

        {payload?.endpoints.map((endpoint) => (
          <div key={endpoint.id} className="space-y-2 rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{endpoint.label}</p>
              <Badge variant={endpoint.enabled ? "default" : "outline"}>{endpoint.enabled ? "Enabled" : "Disabled"}</Badge>
              <span className="text-xs text-muted-foreground">{endpoint.destinationHost}</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {endpoint.events.map(eventLabel).join(", ") || "No events"}
              {endpoint.notifyOriginator ? " · originators" : ""}
              {endpoint.notifyCloser ? " · closers" : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busyId === endpoint.id} onClick={() => void testEndpoint(endpoint.id)}>
                Test webhook
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busyId === endpoint.id} onClick={() => void removeEndpoint(endpoint.id)}>
                <Trash2 className="size-3.5" /> Remove webhook
              </Button>
            </div>
          </div>
        ))}

        <div className="space-y-2">
          <h3 className="text-sm font-medium">Outbox</h3>
          {!payload?.outbox.length ? (
            <p className="text-sm text-muted-foreground">No webhook outbox items yet.</p>
          ) : (
            <ul className="space-y-2">
              {payload.outbox.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <div>
                    <p><span className="font-medium">{eventLabel(item.eventType)}</span> · {item.state} · attempt {item.attempts}</p>
                    <p className="text-xs text-muted-foreground">event id {item.eventId}{item.lastError ? ` · ${item.lastError}` : ""}</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled={busyId === item.id} onClick={() => void replay(item.id)}>
                    <RotateCcw className="size-3.5" /> Replay
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">Delivery log</h3>
          {!payload?.deliveries.length ? (
            <p className="text-sm text-muted-foreground">No webhook deliveries yet.</p>
          ) : (
            <ul className="space-y-2">
              {payload.deliveries.map((item) => (
                <li key={item.id} className="rounded-md border px-3 py-2 text-sm">
                  <p>
                    <span className="font-medium">{eventLabel(item.eventType)}</span> · {item.state} · attempt {item.attempt}
                    {item.httpStatus != null ? ` · HTTP ${item.httpStatus}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    event id {item.eventId}
                    {item.error ? ` · ${item.error}` : ""}
                    {` · ${item.createdAt}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
