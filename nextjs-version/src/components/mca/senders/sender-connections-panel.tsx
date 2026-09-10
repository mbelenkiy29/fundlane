"use client"

import * as React from "react"
import { Mail, RefreshCw, ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RequestError, requestJson } from "@/lib/mca/client"

type SenderProvider = "google" | "microsoft" | "smtp" | "sendgrid"
type SenderPurpose = "merchant" | "submission" | "fallback"
type SenderState = "pending" | "verified" | "expired" | "revoked"

type SenderConnection = {
  id: string
  workspaceId: string
  provider: SenderProvider
  purpose: SenderPurpose
  fromName: string
  fromAddress: string
  signature?: string
  state: SenderState
  isDefault: boolean
  verifiedAt?: string
  lastError?: string
  hasCredential: boolean
  memberIds: string[]
  createdAt: string
  updatedAt: string
  reconnect?: { available: true; method: "oauth" | "credentials" }
}

type SenderTestSendResult = {
  delivery: "sent" | "preview" | "failed"
  correlationId: string
  providerMessageId?: string
  previewUrl?: string
  error?: string
}

type ListPayload = {
  senders: SenderConnection[]
  oauth: { google: boolean; microsoft: boolean }
  canManage: boolean
}

type MembershipOption = { id: string; name: string; email: string; role: string; status: string }

const PROVIDERS: SenderProvider[] = ["google", "microsoft", "smtp", "sendgrid"]
const PURPOSES: SenderPurpose[] = ["merchant", "submission", "fallback"]

function stateLabel(state: SenderState): string {
  if (state === "verified") return "Verified"
  if (state === "pending") return "Pending"
  if (state === "expired") return "Expired"
  return "Revoked"
}

function stateVariant(state: SenderState): "default" | "secondary" | "destructive" | "outline" {
  if (state === "verified") return "default"
  if (state === "pending") return "outline"
  return "destructive"
}

function providerLabel(provider: SenderProvider): string {
  if (provider === "google") return "Google"
  if (provider === "microsoft") return "Microsoft"
  if (provider === "sendgrid") return "SendGrid"
  return "SMTP"
}

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof RequestError) {
    const fields = caught.fieldErrors ? Object.values(caught.fieldErrors).flat().filter(Boolean) : []
    if (fields.length) return fields.join(" ")
    return caught.message
  }
  return caught instanceof Error ? caught.message : fallback
}

const emptyForm = {
  provider: "smtp" as SenderProvider,
  purpose: "submission" as SenderPurpose,
  fromName: "",
  fromAddress: "",
  signature: "",
  isDefault: false,
  memberIds: [] as string[],
  host: "",
  port: "587",
  username: "",
  password: "",
  apiKey: "",
}

export function SenderConnectionsPanel() {
  const [payload, setPayload] = React.useState<ListPayload>()
  const [memberships, setMemberships] = React.useState<MembershipOption[]>([])
  const [form, setForm] = React.useState(emptyForm)
  const [testTo, setTestTo] = React.useState<Record<string, string>>({})
  const [smtpPassword, setSmtpPassword] = React.useState<Record<string, string>>({})
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<ListPayload>("/api/mca/senders")
      setPayload(next)
      if (next.canManage) {
        try {
          const listed = await requestJson<{ memberships: MembershipOption[] }>("/api/memberships")
          setMemberships((listed.memberships ?? []).filter((item) => item.status === "active"))
        } catch {
          setMemberships([])
        }
      }
    } catch (caught) {
      setError(errorMessage(caught, "Email senders could not be loaded."))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("sender") === "connected") setMessage("Email sender connected.")
    if (params.get("sender") === "error") setError("Email sender authorization failed. Start the connection again.")
  }, [])

  function patchForm<K extends keyof typeof emptyForm>(key: K, value: (typeof emptyForm)[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setBusy("create")
    setError(undefined)
    setMessage(undefined)
    try {
      const created = await requestJson<SenderConnection>("/api/mca/senders", {
        method: "POST",
        body: JSON.stringify({
          provider: form.provider,
          purpose: form.purpose,
          fromName: form.fromName,
          fromAddress: form.fromAddress,
          signature: form.signature || undefined,
          isDefault: form.isDefault,
          memberIds: form.memberIds,
          ...(form.provider === "smtp" ? { smtp: { host: form.host, port: Number(form.port), username: form.username, password: form.password } } : {}),
          ...(form.provider === "sendgrid" ? { sendgrid: { apiKey: form.apiKey } } : {}),
        }),
      })
      setForm(emptyForm)
      if (created.provider === "google" || created.provider === "microsoft") {
        await startOAuth(created.id)
        return
      }
      setMessage(`${created.fromName} was saved.`)
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "The sender could not be saved."))
    } finally {
      setBusy(undefined)
    }
  }

  async function startOAuth(id: string) {
    setBusy(`oauth:${id}`)
    setError(undefined)
    setMessage(undefined)
    try {
      const started = await requestJson<{ authorizationUrl: string }>(`/api/mca/senders/${encodeURIComponent(id)}/oauth`, {
        method: "POST",
        body: "{}",
      })
      window.location.href = started.authorizationUrl
    } catch (caught) {
      if (caught instanceof RequestError && caught.code === "sender_oauth_not_configured") {
        setError(caught.message)
        await load()
        return
      }
      setError(errorMessage(caught, "OAuth could not be started."))
      await load()
    } finally {
      setBusy(undefined)
    }
  }

  async function patch(id: string, body: Record<string, unknown>, success: string) {
    setBusy(id)
    setError(undefined)
    setMessage(undefined)
    try {
      await requestJson<SenderConnection>(`/api/mca/senders/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      })
      setMessage(success)
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "The sender could not be updated."))
    } finally {
      setBusy(undefined)
    }
  }

  async function sendTest(id: string) {
    setBusy(`test:${id}`)
    setError(undefined)
    setMessage(undefined)
    try {
      const result = await requestJson<SenderTestSendResult>(`/api/mca/senders/${encodeURIComponent(id)}/test`, {
        method: "POST",
        body: JSON.stringify({ to: testTo[id] || undefined }),
      })
      if (result.delivery === "failed") setError(result.error ?? "Test send failed.")
      else setMessage(result.delivery === "preview" ? "Test send previewed without a live provider." : result.providerMessageId ? `Test send accepted. Provider message ID: ${result.providerMessageId}` : "Test send accepted.")
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "Test send failed."))
    } finally {
      setBusy(undefined)
    }
  }

  const senders = payload?.senders ?? []
  const canManage = payload?.canManage === true
  const needsSmtp = form.provider === "smtp"
  const needsSendGrid = form.provider === "sendgrid"

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email senders</CardTitle>
        <CardDescription>
          Connect Google, Microsoft, SMTP, or SendGrid. Share senders with selected members, set a default per purpose, and reconnect without dropping the record.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading email senders…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}

        {!loading && senders.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No email senders yet. {canManage ? "Connect a provider to send merchant, submission, or fallback mail." : "An administrator can share a sender with you."}
          </div>
        )}

        {senders.map((sender) => (
          <div key={sender.id} className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium">{sender.fromName} &lt;{sender.fromAddress}&gt;</p>
                <p className="text-xs text-muted-foreground">{providerLabel(sender.provider)} · {sender.purpose}</p>
                {canManage && <p className="text-xs text-muted-foreground">Connection ID: {sender.id}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={stateVariant(sender.state)}>{stateLabel(sender.state)}</Badge>
                {sender.isDefault && <Badge variant="secondary">Default {sender.purpose}</Badge>}
                <Badge variant={sender.hasCredential ? "default" : "outline"}>{sender.hasCredential ? "Credential saved" : "No credential"}</Badge>
              </div>
            </div>
            {sender.state === "expired" && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <ShieldAlert className="size-4" />This connection expired. Reconnect to keep the same sender and members.
              </p>
            )}
            {canManage && sender.reconnect?.method === "oauth" && (
              <Button variant="outline" onClick={() => void startOAuth(sender.id)} disabled={Boolean(busy)} aria-label={`Reconnect ${sender.fromName}`}>
                <RefreshCw className="size-4" />{busy === `oauth:${sender.id}` ? "Starting…" : "Reconnect"}
              </Button>
            )}
            {canManage && sender.reconnect?.method === "credentials" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder={sender.provider === "sendgrid" ? "New SendGrid API key" : "New SMTP password"}
                  value={smtpPassword[sender.id] ?? ""}
                  onChange={(event) => setSmtpPassword((current) => ({ ...current, [sender.id]: event.target.value }))}
                  disabled={Boolean(busy)}
                />
                <Button
                  variant="outline"
                  disabled={Boolean(busy) || !(smtpPassword[sender.id] ?? "").trim()}
                  onClick={() => void patch(
                    sender.id,
                    sender.provider === "sendgrid"
                      ? { sendgrid: { apiKey: smtpPassword[sender.id] } }
                      : { smtp: { password: smtpPassword[sender.id] } },
                    "Credentials replaced. Send a test to verify.",
                  )}
                >
                  Reconnect
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid min-w-56 flex-1 gap-2">
                <Label htmlFor={`test-${sender.id}`}>Test recipient</Label>
                <Input
                  id={`test-${sender.id}`}
                  type="email"
                  placeholder={sender.fromAddress}
                  value={testTo[sender.id] ?? ""}
                  onChange={(event) => setTestTo((current) => ({ ...current, [sender.id]: event.target.value }))}
                  disabled={Boolean(busy)}
                />
              </div>
              <Button variant="outline" onClick={() => void sendTest(sender.id)} disabled={Boolean(busy)} aria-label={`Send test from ${sender.fromName}`}>
                <Mail className="size-4" />{busy === `test:${sender.id}` ? "Sending…" : "Send test"}
              </Button>
            </div>
            {canManage && (
              <div className="flex flex-wrap gap-2">
                {!sender.isDefault && (
                  <Button variant="outline" onClick={() => void patch(sender.id, { isDefault: true }, `Default ${sender.purpose} sender updated.`)} disabled={Boolean(busy)}>
                    Make default
                  </Button>
                )}
                {sender.state !== "revoked" && (
                  <Button variant="outline" onClick={() => void patch(sender.id, { revoke: true }, "Sender revoked. The record and members were kept.")} disabled={Boolean(busy)}>
                    Revoke
                  </Button>
                )}
              </div>
            )}
            {canManage && memberships.length > 0 && (
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Permitted members</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {memberships.map((membership) => {
                    const checked = sender.memberIds.includes(membership.id)
                    return (
                      <label key={membership.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={Boolean(busy)}
                          onChange={() => {
                            const memberIds = checked
                              ? sender.memberIds.filter((id) => id !== membership.id)
                              : [...sender.memberIds, membership.id]
                            void patch(sender.id, { memberIds }, "Sender members updated.")
                          }}
                        />
                        {membership.name} ({membership.role})
                      </label>
                    )
                  })}
                </div>
              </fieldset>
            )}
          </div>
        ))}

        {canManage && (
          <form className="space-y-4 rounded-lg border p-4" onSubmit={(event) => void create(event)}>
            <p className="font-medium">Connect a sender</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="sender-provider">Provider</Label>
                <select
                  id="sender-provider"
                  className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
                  value={form.provider}
                  onChange={(event) => patchForm("provider", event.target.value as SenderProvider)}
                  disabled={Boolean(busy)}
                >
                  {PROVIDERS.map((provider) => <option key={provider} value={provider}>{providerLabel(provider)}</option>)}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sender-purpose">Purpose</Label>
                <select
                  id="sender-purpose"
                  className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
                  value={form.purpose}
                  onChange={(event) => patchForm("purpose", event.target.value as SenderPurpose)}
                  disabled={Boolean(busy)}
                >
                  {PURPOSES.map((purpose) => <option key={purpose} value={purpose}>{purpose}</option>)}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sender-from-name">From name</Label>
                <Input id="sender-from-name" value={form.fromName} onChange={(event) => patchForm("fromName", event.target.value)} disabled={Boolean(busy)} required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sender-from-address">From address</Label>
                <Input id="sender-from-address" type="email" value={form.fromAddress} onChange={(event) => patchForm("fromAddress", event.target.value)} disabled={Boolean(busy)} required />
              </div>
            </div>
            {needsSmtp && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="sender-host">SMTP host</Label>
                  <Input id="sender-host" value={form.host} onChange={(event) => patchForm("host", event.target.value)} disabled={Boolean(busy)} required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="sender-port">Port</Label>
                  <Input id="sender-port" inputMode="numeric" value={form.port} onChange={(event) => patchForm("port", event.target.value)} disabled={Boolean(busy)} required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="sender-username">Username</Label>
                  <Input id="sender-username" value={form.username} onChange={(event) => patchForm("username", event.target.value)} disabled={Boolean(busy)} required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="sender-password">Password</Label>
                  <Input id="sender-password" type="password" autoComplete="off" value={form.password} onChange={(event) => patchForm("password", event.target.value)} disabled={Boolean(busy)} required />
                </div>
              </div>
            )}
            {needsSendGrid && (
              <div className="grid gap-2">
                <Label htmlFor="sender-sendgrid">SendGrid API key</Label>
                <Input id="sender-sendgrid" type="password" autoComplete="off" value={form.apiKey} onChange={(event) => patchForm("apiKey", event.target.value)} disabled={Boolean(busy)} required />
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="sender-signature">Signature</Label>
              <Textarea id="sender-signature" value={form.signature} onChange={(event) => patchForm("signature", event.target.value)} disabled={Boolean(busy)} rows={3} />
            </div>
            {memberships.length > 0 && (
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Share with members</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {memberships.map((membership) => (
                    <label key={membership.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.memberIds.includes(membership.id)}
                        disabled={Boolean(busy)}
                        onChange={(event) => {
                          patchForm("memberIds", event.target.checked
                            ? [...form.memberIds, membership.id]
                            : form.memberIds.filter((id) => id !== membership.id))
                        }}
                      />
                      {membership.name} ({membership.role})
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.isDefault} onChange={(event) => patchForm("isDefault", event.target.checked)} disabled={Boolean(busy)} />
              Make default for this purpose
            </label>
            {(form.provider === "google" || form.provider === "microsoft") && payload && !payload.oauth[form.provider] && (
              <p className="text-sm text-muted-foreground">
                {form.provider === "google" ? "Google" : "Microsoft"} OAuth is not configured. Saving still creates a reconnectable pending sender.
              </p>
            )}
            <Button type="submit" disabled={Boolean(busy)}>{busy === "create" ? "Saving…" : "Save sender"}</Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
