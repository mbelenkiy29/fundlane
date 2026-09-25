"use client"

import * as React from "react"
import { KeyRound, Loader2, RefreshCw, ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RequestError, requestJson } from "@/lib/mca/client"
import { funderSubmissionChannelStatus } from "@/lib/mca/integrations/connection-status"
import { ConnectionStatusBadge } from "@/components/mca/integrations/connection-status"

type AdapterEnvironment = "development" | "production"
type AdapterCapabilities = { submit: true; statusPoll: boolean; webhooks: boolean; offers: boolean }

type AdapterLastAction = {
  action: "submit" | "status"
  correlationId: string
  externalRef?: string
  errorCode?: string
  errorMessage?: string
  fields?: Record<string, string>
  rateLimit?: { retryAfterSeconds: number; retryAt: string }
  rawStatus?: string
  at: string
}

type AdapterCredential = {
  id: string
  funderId: string
  funderName?: string
  adapterSlug: string
  readiness: "live" | "sandbox" | "unavailable"
  environment: AdapterEnvironment
  hasCredential: boolean
  capabilities: AdapterCapabilities
  active: boolean
  secretHints: Record<string, boolean>
  lastAction?: AdapterLastAction
  updatedAt: string
}

type ListPayload = {
  adapters: Array<{ slug: string; readiness: "live" | "sandbox" | "unavailable"; capabilities: AdapterCapabilities }>
  credentials: AdapterCredential[]
  funders: Array<{ id: string; name: string; adapterSlug?: string; hasApiRoute: boolean }>
  environments: AdapterEnvironment[]
  canManage: boolean
}

type ActionResult = {
  ok: boolean
  action: "submit" | "status"
  credentialId: string
  correlationId: string
  externalRef?: string
  errorCode?: string
  errorMessage?: string
  fields?: Record<string, string>
  rateLimit?: { retryAfterSeconds: number; retryAt: string }
  rawStatus?: string
  capabilities: AdapterCapabilities
}

const emptyForm = {
  funderId: "",
  adapterSlug: "",
  environment: "development" as AdapterEnvironment,
  apiKey: "",
  clientId: "",
  clientSecret: "",
  username: "",
  password: "",
  baseUrl: "",
  webhookSecret: "",
}

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof RequestError) {
    const fields = caught.fieldErrors ? Object.values(caught.fieldErrors).flat().filter(Boolean) : []
    if (fields.length) return fields.join(" ")
    return caught.message
  }
  return caught instanceof Error ? caught.message : fallback
}

function environmentLabel(environment: AdapterEnvironment): string {
  return environment === "production" ? "Production" : "Development"
}

export function AdapterCredentialsPanel() {
  const [payload, setPayload] = React.useState<ListPayload>()
  const [form, setForm] = React.useState(emptyForm)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})
  const [rateLimit, setRateLimit] = React.useState<{ credentialId: string; retryAt: string; externalRef?: string; correlationId: string }>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      setPayload(await requestJson<ListPayload>("/api/mca/adapters"))
    } catch (caught) {
      setError(errorMessage(caught, "Adapter credentials could not be loaded."))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  function patchForm<K extends keyof typeof emptyForm>(key: K, value: (typeof emptyForm)[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function captureFailure(caught: unknown, fallback: string, credentialId?: string) {
    if (caught instanceof RequestError) {
      const fields = caught.fieldErrors ?? {}
      const mapped: Record<string, string> = {}
      for (const [key, values] of Object.entries(fields)) {
        if (values[0]) mapped[key] = values[0]
      }
      setFieldErrors(mapped)
      if (caught.code === "rate_limited") {
        setRateLimit({
          credentialId: credentialId ?? "",
          retryAt: mapped.retryAt ?? new Date(Date.now() + 60_000).toISOString(),
          externalRef: mapped.externalRef,
          correlationId: mapped.correlationId ?? "",
        })
      }
    }
    setError(errorMessage(caught, fallback))
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy("save")
    setError(undefined)
    setMessage(undefined)
    setFieldErrors({})
    try {
      const saved = await requestJson<AdapterCredential>("/api/mca/adapters", {
        method: "POST",
        body: JSON.stringify({
          funderId: form.funderId,
          adapterSlug: form.adapterSlug,
          environment: form.environment,
          secrets: {
            apiKey: form.apiKey || undefined,
            clientId: form.clientId || undefined,
            clientSecret: form.clientSecret || undefined,
            username: form.username || undefined,
            password: form.password || undefined,
            baseUrl: form.baseUrl || undefined,
            webhookSecret: form.webhookSecret || undefined,
          },
        }),
      })
      setForm((current) => ({ ...emptyForm, funderId: current.funderId, adapterSlug: current.adapterSlug, environment: current.environment }))
      setMessage(`${saved.adapterSlug} ${environmentLabel(saved.environment).toLowerCase()} credentials saved.`)
      await load()
    } catch (caught) {
      captureFailure(caught, "Adapter credentials could not be saved.")
    } finally {
      setBusy(undefined)
    }
  }

  async function checkStatus(credential: AdapterCredential) {
    setBusy(`status:${credential.id}`)
    setError(undefined)
    setMessage(undefined)
    setFieldErrors({})
    try {
      const result = await requestJson<ActionResult>(`/api/mca/adapters/${encodeURIComponent(credential.id)}/status`, {
        method: "POST",
        body: "{}",
      })
      setMessage(result.rawStatus ? `Status: ${result.rawStatus}. External reference ${result.externalRef ?? result.correlationId}.` : "Status check completed.")
      await load()
    } catch (caught) {
      captureFailure(caught, "Status check failed.", credential.id)
      await load()
    } finally {
      setBusy(undefined)
    }
  }

  async function retry(credential: AdapterCredential) {
    setBusy(`retry:${credential.id}`)
    setError(undefined)
    setMessage(undefined)
    try {
      const result = await requestJson<ActionResult>(`/api/mca/adapters/${encodeURIComponent(credential.id)}/retry`, {
        method: "POST",
        body: JSON.stringify({
          action: credential.capabilities.statusPoll ? "status" : "submit",
          correlationId: credential.lastAction?.correlationId || rateLimit?.correlationId,
          externalRef: credential.lastAction?.externalRef || rateLimit?.externalRef,
        }),
      })
      setRateLimit(undefined)
      setMessage(result.ok
        ? `Retry succeeded. External reference ${result.externalRef ?? result.correlationId}.`
        : result.errorMessage ?? "Retry finished.")
      await load()
    } catch (caught) {
      captureFailure(caught, "Retry failed.", credential.id)
      await load()
    } finally {
      setBusy(undefined)
    }
  }

  const credentials = payload?.credentials ?? []
  const canManage = payload?.canManage === true
  const funders = payload?.funders ?? []
  const funderStatus = funderSubmissionChannelStatus({
    funders: funders.map((funder) => ({ hasApiRoute: funder.hasApiRoute })),
    credentials,
  })

  return (
    <Card id="funder-adapters">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">Funder API adapters <ConnectionStatusBadge label={funderStatus.label} /></CardTitle>
        <CardDescription>
          Configure a funder API route and its workspace credentials. Sandbox runs locally; unavailable adapters have no verified live delivery.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading adapter credentials…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
        {Object.keys(fieldErrors).length > 0 && (
          <div className="rounded-md border border-destructive/40 p-3 text-sm" role="alert">
            <p className="font-medium">Correct the highlighted fields and retry.</p>
            <ul className="mt-2 list-disc pl-5">
              {Object.entries(fieldErrors).filter(([key]) => !["retryAt", "retryAfterSeconds", "externalRef", "correlationId"].includes(key)).map(([key, value]) => (
                <li key={key}>{key}: {value}</li>
              ))}
            </ul>
          </div>
        )}

        {!loading && credentials.length === 0 && funders.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Not connected. Add an API route on a funder, then select the sandbox adapter for local testing.
          </div>
        )}

        {credentials.map((credential) => {
          const statusAllowed = credential.capabilities.statusPoll
          const limited = credential.lastAction?.errorCode === "rate_limited" || rateLimit?.credentialId === credential.id
          return (
            <div key={credential.id} className="space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{credential.funderName || credential.funderId}</p>
                  <p className="text-xs text-muted-foreground">{credential.adapterSlug} · {environmentLabel(credential.environment)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={credential.readiness === "live" ? "default" : "outline"}>{credential.readiness}</Badge>
                  <Badge variant={credential.environment === "production" ? "default" : "secondary"}>{environmentLabel(credential.environment)}</Badge>
                  <Badge variant={credential.hasCredential ? "default" : "outline"}>{credential.hasCredential ? "Credential saved" : "No credential"}</Badge>
                  {!credential.active && <Badge variant="destructive">Inactive</Badge>}
                  {statusAllowed ? <Badge variant="outline">Status poll</Badge> : <Badge variant="outline">Submit only</Badge>}
                </div>
              </div>
              {limited && (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <ShieldAlert className="size-4" />
                  Rate limited. Retry after {credential.lastAction?.rateLimit?.retryAt || rateLimit?.retryAt}.
                  External reference {credential.lastAction?.externalRef || rateLimit?.externalRef || credential.lastAction?.correlationId}.
                </p>
              )}
              {credential.lastAction?.externalRef && !limited && (
                <p className="text-xs text-muted-foreground">Last external reference {credential.lastAction.externalRef}</p>
              )}
              {canManage && (statusAllowed || limited || credential.lastAction) && (
                <div className="flex flex-wrap gap-2">
                  {statusAllowed && (
                    <Button variant="outline" onClick={() => void checkStatus(credential)} disabled={Boolean(busy)} aria-label={`Check status for ${credential.adapterSlug}`}>
                      {busy === `status:${credential.id}` ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                      Check status
                    </Button>
                  )}
                  {(limited || credential.lastAction) && (
                    <Button variant="outline" onClick={() => void retry(credential)} disabled={Boolean(busy)} aria-label={`Retry ${credential.adapterSlug}`}>
                      {busy === `retry:${credential.id}` ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                      Retry
                    </Button>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {canManage && (
          <form className="space-y-4 rounded-lg border p-4" onSubmit={(event) => void save(event)}>
            <p className="font-medium">Save environment credentials</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="adapter-funder">Funder</Label>
                <select
                  id="adapter-funder"
                  className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
                  value={form.funderId}
                  onChange={(event) => {
                    const funder = funders.find((item) => item.id === event.target.value)
                    setForm((current) => ({ ...current, funderId: event.target.value, adapterSlug: funder?.adapterSlug || "" }))
                  }}
                  disabled={Boolean(busy)}
                  required
                >
                  <option value="">Select a funder</option>
                  {funders.map((funder) => <option key={funder.id} value={funder.id}>{funder.name}</option>)}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="adapter-slug">Adapter</Label>
                <select id="adapter-slug" className="border-input h-9 rounded-md border bg-transparent px-3 text-sm" value={form.adapterSlug} onChange={(event) => patchForm("adapterSlug", event.target.value)} disabled={Boolean(busy)} required>
                  <option value="">Select an adapter</option>
                  {payload?.adapters.map((adapter) => <option key={adapter.slug} value={adapter.slug}>{adapter.slug} · {adapter.readiness}</option>)}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="adapter-environment">Environment</Label>
                <select
                  id="adapter-environment"
                  className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
                  value={form.environment}
                  onChange={(event) => patchForm("environment", event.target.value as AdapterEnvironment)}
                  disabled={Boolean(busy)}
                >
                  <option value="development">Development</option>
                  <option value="production">Production</option>
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="adapter-base-url">Base URL</Label>
                <Input id="adapter-base-url" value={form.baseUrl} onChange={(event) => patchForm("baseUrl", event.target.value)} disabled={Boolean(busy)} placeholder="https://" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="adapter-api-key">API key</Label>
                <Input id="adapter-api-key" type="password" autoComplete="off" value={form.apiKey} onChange={(event) => patchForm("apiKey", event.target.value)} disabled={Boolean(busy)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="adapter-webhook-secret">Webhook secret</Label>
                <Input id="adapter-webhook-secret" type="password" autoComplete="off" value={form.webhookSecret} onChange={(event) => patchForm("webhookSecret", event.target.value)} disabled={Boolean(busy)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="adapter-client-id">Client ID</Label>
                <Input id="adapter-client-id" value={form.clientId} onChange={(event) => patchForm("clientId", event.target.value)} disabled={Boolean(busy)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="adapter-client-secret">Client secret</Label>
                <Input id="adapter-client-secret" type="password" autoComplete="off" value={form.clientSecret} onChange={(event) => patchForm("clientSecret", event.target.value)} disabled={Boolean(busy)} />
              </div>
            </div>
            <Button type="submit" disabled={Boolean(busy)}>
              {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              Save credentials
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
