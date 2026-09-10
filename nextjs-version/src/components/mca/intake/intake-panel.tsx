"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Clipboard, Link2, Loader2, Play, RefreshCw, RotateCw, Webhook } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

type Integration = {
  id: string; provider: string; displayName: string; binding: string | null; enabled: boolean
  credential: "configured" | "missing" | "expired"; credentialVersion: number
  approvalState: "approved" | "pending_customer_contract"; mapping: Record<string, string>
  allowedHosts: string[]; senderRules: string[]; assignmentPool: string[]; initialStatus: string
  inboundAddress?: string; contractKey?: string; attachmentMethod?: string; emailGateway?: "usesend" | "postmark" | "custom"
  providerServerId?: string; readiness: "local_tested" | "live_unverified" | "live_configured"; updatedAt: string
}
type Intake = { intakeId: string; provider: string; eventId: string; dealId: string | null; state: string; warnings: string[]; errorCode?: string; errorMessage?: string; attachmentStates: Record<string, number>; updatedAt: string }

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status}).`)
  return body as T
}

const providers = ["jotform", "fillout", "highlevel", "docuseal", "custom", "zoho", "email"]

export function IntakePanel() {
  const [integrations, setIntegrations] = React.useState<Integration[]>([])
  const [intakes, setIntakes] = React.useState<Intake[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const [notice, setNotice] = React.useState<string>()
  const [secret, setSecret] = React.useState<string>()
  const [provider, setProvider] = React.useState("jotform")
  const [emailGateway, setEmailGateway] = React.useState<"usesend" | "postmark" | "custom">("usesend")
  const [previewIntegration, setPreviewIntegration] = React.useState<string>()
  const [previewPayload, setPreviewPayload] = React.useState("{}")
  const [previewResult, setPreviewResult] = React.useState<string>()

  const load = React.useCallback(async () => {
    setLoading(true); setError(undefined)
    try {
      const [configured, history] = await Promise.all([
        jsonRequest<{ integrations: Integration[] }>("/api/mca/intake/integrations"),
        jsonRequest<{ intakes: Intake[] }>("/api/mca/intake"),
      ])
      setIntegrations(configured.integrations); setIntakes(history.intakes)
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load intake settings.") }
    finally { setLoading(false) }
  }, [])
  React.useEffect(() => { void load() }, [load])

  async function createIntegration(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("create"); setError(undefined); setNotice(undefined); setSecret(undefined)
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      const binding = String(data.get("binding") ?? "").trim()
      const body = {
        provider, displayName: String(data.get("displayName") ?? ""),
        ...(provider === "docuseal" ? { templateId: binding } : provider === "highlevel" ? { locationId: binding } : provider === "email" ? { inboundAddress: binding } : { formId: binding }),
        credential: String(data.get("credential") ?? "") || undefined,
        credentialExpiresAt: String(data.get("credentialExpiresAt") ?? "") || undefined,
        allowedHosts: String(data.get("allowedHosts") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        senderRules: String(data.get("senderRules") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        assignmentPool: String(data.get("assignmentPool") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        initialStatus: String(data.get("initialStatus") ?? "lead"),
        mapping: JSON.parse(String(data.get("mapping") ?? "{}")),
        customerContractApproved: data.get("customerContractApproved") === "on",
        ...(provider === "zoho" ? { contractKey: "zoho_forms_json_drive_v1" } : {}),
        ...(provider === "email" ? { emailGateway } : {}),
      }
      const result = await jsonRequest<{ status: Integration; admissionSecret?: string }>("/api/mca/intake/integrations", { method: "POST", body: JSON.stringify(body) })
      setSecret(result.admissionSecret); setNotice(`${result.status.displayName} is configured.`); form.reset(); await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the integration.") }
    finally { setBusy(undefined) }
  }

  async function provisionUsesend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("usesend-provision"); setError(undefined); setNotice(undefined); setSecret(undefined)
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      const body = {
        apiKey: String(data.get("apiKey") ?? ""), inboundAddress: String(data.get("inboundAddress") ?? ""),
        fromAddress: String(data.get("fromAddress") ?? ""), displayName: String(data.get("displayName") ?? ""),
        publicOrigin: String(data.get("publicOrigin") ?? ""),
        senderRules: String(data.get("senderRules") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        assignmentPool: String(data.get("assignmentPool") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      }
      const result = await jsonRequest<{ status: Integration; admissionSecret: string; webhookUrl: string }>("/api/mca/intake/integrations/usesend/provision", { method: "POST", body: JSON.stringify(body) })
      setSecret(result.admissionSecret)
      setNotice(`useSend verified domain sending for ${result.status.inboundAddress}. Point that mailbox at ${result.webhookUrl} with HMAC headers. useSend does not issue inbound addresses.`)
      form.reset(); await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : "useSend setup failed.") }
    finally { setBusy(undefined) }
  }

  async function provisionPostmark(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("postmark-provision"); setError(undefined); setNotice(undefined); setSecret(undefined)
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      const body = {
        accountToken: String(data.get("accountToken") ?? ""), serverId: String(data.get("serverId") ?? "") || undefined,
        createServer: data.get("createServer") === "on", serverName: String(data.get("serverName") ?? ""),
        displayName: String(data.get("displayName") ?? ""), publicOrigin: String(data.get("publicOrigin") ?? ""),
        senderRules: String(data.get("senderRules") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        assignmentPool: String(data.get("assignmentPool") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      }
      const result = await jsonRequest<{ status: Integration; admissionSecret: string }>("/api/mca/intake/integrations/postmark/provision", { method: "POST", body: JSON.stringify(body) })
      setSecret(result.admissionSecret); setNotice(`Postmark verified ${result.status.inboundAddress} and configured its inbound webhook.`); form.reset(); await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Postmark setup failed.") }
    finally { setBusy(undefined) }
  }

  async function rotate(integration: Integration, form: HTMLFormElement) {
    setBusy(`rotate:${integration.id}`); setError(undefined); setSecret(undefined)
    const data = new FormData(form)
    try {
      const result = await jsonRequest<{ status: Integration; admissionSecret?: string }>(`/api/mca/intake/integrations/${integration.id}/rotate`, {
        method: "POST", body: JSON.stringify({ credential: String(data.get("credential") ?? "") || undefined, credentialExpiresAt: String(data.get("credentialExpiresAt") ?? "") || undefined, admissionSecret: String(data.get("admissionSecret") ?? "") || undefined }),
      })
      setSecret(result.admissionSecret); setNotice(`${integration.displayName} credentials rotated to version ${result.status.credentialVersion}.`); form.reset(); await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Credential rotation failed.") }
    finally { setBusy(undefined) }
  }

  async function createLink(integration: Integration, membershipId: string) {
    setBusy(`link:${integration.id}`); setError(undefined)
    try {
      const result = await jsonRequest<{ url: string }>(`/api/mca/intake/integrations/${integration.id}/rep-links`, { method: "POST", body: JSON.stringify({ membershipId }) })
      await navigator.clipboard.writeText(result.url); setNotice("Personal Jotform link copied. Creating another link for this rep rotates the prior token.")
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create the rep link.") }
    finally { setBusy(undefined) }
  }

  async function run(path: string, key: string, message: string, body: unknown = {}) {
    setBusy(key); setError(undefined)
    try {
      const result = await jsonRequest<{ state?: string; receipts?: Array<{ state: string }>; errorMessage?: string }>(path, { method: "POST", body: JSON.stringify(body) })
      await load()
      if (result.state === "error" || result.receipts?.some((receipt) => receipt.state === "failed")) {
        setNotice(undefined); setError(result.errorMessage ?? "Some items still need attention. Review the intake or delivery configuration and retry.")
      } else setNotice(message)
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The operation failed.") }
    finally { setBusy(undefined) }
  }

  async function preview() {
    if (!previewIntegration) return setError("Choose an integration to preview.")
    setBusy("preview"); setError(undefined); setPreviewResult(undefined)
    try {
      const payload = JSON.parse(previewPayload)
      const result = await jsonRequest<Record<string, unknown>>(`/api/mca/intake/integrations/${previewIntegration}/preview`, { method: "POST", body: JSON.stringify(payload) })
      setPreviewResult(JSON.stringify(result, null, 2))
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Preview failed.") }
    finally { setBusy(undefined) }
  }

  if (loading) return <Card><CardContent className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading intake integrations…</CardContent></Card>

  return <div className="space-y-6">
    {(error || notice || secret) && <div className={`rounded-lg border p-4 text-sm ${error ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-emerald-500/30 bg-emerald-500/5"}`} role={error ? "alert" : "status"}>
      <div className="flex items-start gap-2">{error ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}<div><p>{error ?? notice}</p>{secret && <div className="mt-2"><p className="font-medium">Copy this one-time webhook secret now:</p><code className="mt-1 block break-all rounded bg-background p-2 text-foreground">{secret}</code></div>}</div></div>
    </div>}

    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Webhook className="size-5" />Application intake</CardTitle><CardDescription>Configure authenticated provider routes, field maps, private file access, and retry behavior. Secrets are never returned after creation or rotation.</CardDescription></CardHeader>
      <CardContent>
        {!integrations.length ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No intake providers are configured. Add the first connection below.</div> : <div className="space-y-4">
          {integrations.map((integration) => <div key={integration.id} className="rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><p className="font-medium">{integration.displayName}</p><Badge variant="outline">{integration.provider}</Badge>{integration.emailGateway && <Badge variant="outline">{integration.emailGateway}</Badge>}<Badge variant={integration.enabled ? "secondary" : "outline"}>{integration.enabled ? "Active" : "Disabled"}</Badge><Badge variant={integration.readiness === "live_configured" ? "secondary" : "outline"}>{integration.readiness.replace(/_/g, " ")}</Badge></div><p className="mt-1 text-xs text-muted-foreground">Binding {integration.binding ?? integration.inboundAddress ?? "not set"} · credential {integration.credential} · version {integration.credentialVersion}</p>{integration.contractKey && <p className="mt-1 text-xs text-muted-foreground">Contract {integration.contractKey} · attachments {integration.attachmentMethod ?? "none"}</p>}{integration.providerServerId && <p className="mt-1 text-xs text-muted-foreground">{integration.emailGateway === "usesend" ? "Verified useSend domain" : "Verified Postmark server"} {integration.providerServerId}</p>}{integration.emailGateway === "usesend" && integration.mapping.fromAddress && <p className="mt-1 text-xs text-muted-foreground">Receipts from {integration.mapping.fromAddress}</p>}</div>{integration.approvalState !== "approved" && <Badge variant="destructive">Custom contract pending</Badge>}</div>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <form onSubmit={(event) => { event.preventDefault(); void rotate(integration, event.currentTarget) }} className="flex flex-wrap gap-2"><Input className="min-w-44 flex-1" name="credential" type="password" placeholder="New private read credential" aria-label="New private read credential" /><Input className="min-w-44 flex-1" name="credentialExpiresAt" placeholder="Expiry ISO timestamp" aria-label="Credential expiry ISO timestamp" /><Input className="min-w-44 flex-1" name="admissionSecret" type="password" placeholder="Optional webhook secret" aria-label="New webhook secret" /><Button type="submit" variant="outline" size="sm" disabled={busy === `rotate:${integration.id}`}><RotateCw className="size-4" />Rotate</Button></form>
              {integration.provider === "jotform" && <form onSubmit={(event) => { event.preventDefault(); void createLink(integration, String(new FormData(event.currentTarget).get("membershipId") ?? "")) }} className="flex gap-2"><Input name="membershipId" placeholder="Active member UUID" aria-label="Active member ID" /><Button type="submit" variant="outline" size="sm" disabled={busy === `link:${integration.id}`}><Link2 className="size-4" />Copy rep link</Button></form>}
            </div>
          </div>)}
        </div>}
      </CardContent>
    </Card>

    <Card><CardHeader><CardTitle>Add provider</CardTitle><CardDescription>Jotform uses a generated bearer secret in a Workflow webhook header, Fillout uses its authorization header, HighLevel uses Ed25519, and DocuSeal uses HMAC. The selected Zoho contract uses flat JSON plus private Google Drive links. Email defaults to useSend HMAC plus useSend receipt sending; Postmark Inbound Basic remains available; choose custom only for the legacy MCA JSON gateway.</CardDescription></CardHeader><CardContent>
      <form onSubmit={createIntegration} className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="intake-provider">Provider</Label><select id="intake-provider" value={provider} onChange={(event) => setProvider(event.target.value)} className="h-9 w-full rounded-md border bg-transparent px-3 text-sm">{providers.map((item) => <option key={item}>{item}</option>)}</select></div>
        {provider === "email" && <div className="space-y-2"><Label htmlFor="intake-email-gateway">Email gateway</Label><select id="intake-email-gateway" value={emailGateway} onChange={(event) => setEmailGateway(event.target.value as "usesend" | "postmark" | "custom")} className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"><option value="usesend">useSend HMAC + receipts</option><option value="postmark">Postmark Inbound Basic</option><option value="custom">Custom MCA JSON bearer</option></select></div>}
        <div className="space-y-2"><Label htmlFor="intake-name">Connection name</Label><Input id="intake-name" name="displayName" required placeholder="Production Jotform" /></div>
        <div className="space-y-2"><Label htmlFor="intake-binding">{provider === "docuseal" ? "Template ID" : provider === "highlevel" ? "Location ID" : provider === "email" ? "Inbound route address" : "Form ID"}</Label><Input id="intake-binding" name="binding" required /></div>
        <div className="space-y-2"><Label htmlFor="intake-credential">{provider === "zoho" ? "Google Drive OAuth access token" : "Private read credential"}</Label><Input id="intake-credential" name="credential" type="password" placeholder={provider === "zoho" ? "Bearer token with access to the Zoho upload folder" : "Needed to fetch private attachments"} /></div>
        {provider === "zoho" && <div className="space-y-2"><Label htmlFor="intake-credential-expiry">Google token expiry (ISO timestamp)</Label><Input id="intake-credential-expiry" name="credentialExpiresAt" required placeholder="2026-09-08T18:00:00.000Z" /></div>}
        <div className="space-y-2 md:col-span-2"><Label htmlFor="intake-hosts">Allowed attachment hosts</Label><Input id="intake-hosts" name="allowedHosts" placeholder="api.jotform.com, www.jotform.com" /></div>
        {provider === "email" && <div className="space-y-2 md:col-span-2"><Label htmlFor="intake-senders">Allowed senders or domains</Label><Input id="intake-senders" name="senderRules" placeholder="partner@example.com, @trusted.example" /></div>}
        <div className="space-y-2"><Label htmlFor="intake-pool">Assignment pool member IDs</Label><Input id="intake-pool" name="assignmentPool" placeholder="UUID, UUID" /></div>
        <div className="space-y-2"><Label htmlFor="intake-status">Initial status</Label><select id="intake-status" name="initialStatus" className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"><option value="lead">Lead</option><option value="new_application">New application</option><option value="missing_documents">Missing documents</option></select></div>
        <div className="space-y-2 md:col-span-2"><Label htmlFor="intake-map">Field map JSON (deal field → provider path)</Label><Textarea id="intake-map" name="mapping" rows={5} defaultValue="{}" spellCheck={false} /></div>
        {provider === "zoho" && <div className="rounded-md border p-3 text-sm md:col-span-2"><p className="font-medium">Selected contract: zoho_forms_json_drive_v1</p><p className="mt-1 text-muted-foreground">Send named flat JSON fields with <code>entryId</code> and <code>formId</code>. Store application and statement uploads in Google Drive and send their links as <code>applicationFile</code> and <code>statementFile</code>. Local fixtures pass; live Zoho serialization and Drive access remain unverified.</p></div>}
        <div className="md:col-span-2"><Button type="submit" disabled={busy === "create"}>{busy === "create" && <Loader2 className="size-4 animate-spin" />}Save integration</Button></div>
      </form>
    </CardContent></Card>

    <Card><CardHeader><CardTitle>Verify useSend domain and receipt sending</CardTitle><CardDescription>useSend verifies a SUCCESS domain and sends receipts from that domain with Idempotency-Key. It does not issue inbound mailboxes. Enter the real address brokers will forward to, then point that mailbox or a worker at the HMAC webhook. The API key is stored encrypted for receipts only.</CardDescription></CardHeader><CardContent><form onSubmit={provisionUsesend} className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2"><Label htmlFor="usesend-display-name">Connection name</Label><Input id="usesend-display-name" name="displayName" required placeholder="Production useSend intake" /></div>
      <div className="space-y-2"><Label htmlFor="usesend-inbound">Workspace intake address</Label><Input id="usesend-inbound" name="inboundAddress" type="email" required placeholder="leads@fundlane.io" /></div>
      <div className="space-y-2"><Label htmlFor="usesend-from">Receipt From address</Label><Input id="usesend-from" name="fromAddress" required placeholder="MCA Intake &lt;intake@fundlane.io&gt;" /></div>
      <div className="space-y-2"><Label htmlFor="usesend-origin">Public HTTPS app origin</Label><Input id="usesend-origin" name="publicOrigin" type="url" required placeholder="https://fundlane.io" /></div>
      <div className="space-y-2 md:col-span-2"><Label htmlFor="usesend-key">useSend API key</Label><Input id="usesend-key" name="apiKey" type="password" required autoComplete="off" /></div>
      <div className="space-y-2"><Label htmlFor="usesend-senders">Allowed senders or domains</Label><Input id="usesend-senders" name="senderRules" placeholder="@trusted.example" /></div>
      <div className="space-y-2"><Label htmlFor="usesend-pool">Assignment pool member IDs</Label><Input id="usesend-pool" name="assignmentPool" placeholder="UUID, UUID" /></div>
      <div className="md:col-span-2"><Button type="submit" disabled={busy === "usesend-provision"}>{busy === "usesend-provision" && <Loader2 className="size-4 animate-spin" />}Verify useSend domain</Button></div>
    </form></CardContent></Card>

    <Card><CardHeader><CardTitle>Verify and configure Postmark Inbound</CardTitle><CardDescription>Use an existing workspace Postmark Server. MCA reads its provider-issued address and configures the public HTTPS webhook with one-time Basic credentials. The account token stays in this request and is not stored. No account is connected in this environment.</CardDescription></CardHeader><CardContent><form onSubmit={provisionPostmark} className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2"><Label htmlFor="postmark-display-name">Connection name</Label><Input id="postmark-display-name" name="displayName" required placeholder="Production Postmark inbound" /></div>
      <div className="space-y-2"><Label htmlFor="postmark-server-name">Exact server name</Label><Input id="postmark-server-name" name="serverName" required /></div>
      <div className="space-y-2"><Label htmlFor="postmark-server-id">Existing server ID</Label><Input id="postmark-server-id" name="serverId" inputMode="numeric" /></div>
      <div className="space-y-2"><Label htmlFor="postmark-origin">Public HTTPS app origin</Label><Input id="postmark-origin" name="publicOrigin" type="url" required placeholder="https://app.example.com" /></div>
      <div className="space-y-2 md:col-span-2"><Label htmlFor="postmark-token">Postmark account token</Label><Input id="postmark-token" name="accountToken" type="password" required autoComplete="off" /></div>
      <div className="space-y-2"><Label htmlFor="postmark-senders">Allowed senders or domains</Label><Input id="postmark-senders" name="senderRules" placeholder="@trusted.example" /></div>
      <div className="space-y-2"><Label htmlFor="postmark-pool">Assignment pool member IDs</Label><Input id="postmark-pool" name="assignmentPool" placeholder="UUID, UUID" /></div>
      <label className="flex items-center gap-2 text-sm md:col-span-2"><input type="checkbox" name="createServer" />Create the named server only when no server ID is supplied and account authorization permits it</label>
      <div className="md:col-span-2"><Button type="submit" disabled={busy === "postmark-provision"}>{busy === "postmark-provision" && <Loader2 className="size-4 animate-spin" />}Verify provider and configure webhook</Button></div>
    </form></CardContent></Card>

    <Card><CardHeader><CardTitle>Mapping preview</CardTitle><CardDescription>Validate a realistic provider fixture without creating a deal or fetching files.</CardDescription></CardHeader><CardContent className="space-y-3">
      <select value={previewIntegration ?? ""} onChange={(event) => setPreviewIntegration(event.target.value)} className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"><option value="">Choose integration</option>{integrations.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>
      <Textarea value={previewPayload} onChange={(event) => setPreviewPayload(event.target.value)} rows={8} spellCheck={false} aria-label="Provider fixture JSON" />
      <Button variant="outline" onClick={() => void preview()} disabled={busy === "preview"}><Play className="size-4" />Preview mapping</Button>
      {previewResult && <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs">{previewResult}</pre>}
    </CardContent></Card>

    <Card><CardHeader><div className="flex items-center justify-between gap-3"><div><CardTitle>Intake activity</CardTitle><CardDescription>Recoverable errors and attachment checkpoints stay visible here.</CardDescription></div><Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="size-4" />Refresh</Button></div></CardHeader><CardContent>
      <div className="mb-4 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => void run("/api/mca/intake/jobs/run", "jobs", "Due attachment jobs processed.")} disabled={busy === "jobs"}><Play className="size-4" />Retry files</Button><Button size="sm" variant="outline" onClick={() => void run("/api/mca/intake/receipts/run", "receipts", "Pending receipt delivery processed.")} disabled={busy === "receipts"}><Clipboard className="size-4" />Send receipts</Button></div>
      {!intakes.length ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No applications have arrived yet.</p> : <div className="space-y-3">{intakes.map((intake) => <div key={intake.intakeId} className="rounded-lg border p-3"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{intake.provider}</Badge><Badge variant={intake.state === "error" ? "destructive" : "secondary"}>{intake.state}</Badge><span className="font-mono text-xs text-muted-foreground">{intake.eventId}</span></div><p className="mt-2 text-sm">{intake.errorMessage ?? (intake.dealId ? `Deal ${intake.dealId}` : "Awaiting review")}</p>{Object.keys(intake.attachmentStates).length > 0 && <p className="mt-1 text-xs text-muted-foreground">Files: {Object.entries(intake.attachmentStates).map(([state, count]) => `${state} ${count}`).join(" · ")}</p>}{intake.warnings.length > 0 && <p className="mt-2 text-sm text-amber-700">{intake.warnings.join(" ")}</p>}{intake.dealId && <a className="mt-2 inline-block text-sm underline" href={`/deals?deal=${intake.dealId}`}>Open deal</a>}{intake.provider === "email" && intake.state === "error" && !["sender_not_allowed", "forwarding_confirmation_review"].includes(intake.errorCode ?? "") && <form className="mt-3 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void run(`/api/mca/intake/${intake.intakeId}/replay`, `replay:${intake.intakeId}`, "Reviewed email saved as a deal.", { reviewedApplication: { legalName: String(data.get("legalName")), contactEmail: String(data.get("contactEmail")) || undefined } }) }}><Input name="legalName" aria-label="Reviewed business name" placeholder="Reviewed business name" required maxLength={200} /><Input name="contactEmail" aria-label="Reviewed merchant email" placeholder="Merchant email (optional)" type="email" /><Button type="submit" size="sm" disabled={busy === `replay:${intake.intakeId}`}>Create reviewed deal</Button></form>}{(intake.state === "error" || (intake.provider === "email" && intake.state === "file_pending")) && <Button className="mt-2" size="sm" variant="outline" onClick={() => void run(`/api/mca/intake/${intake.intakeId}/replay`, `replay:${intake.intakeId}`, "Intake replayed.")} disabled={busy === `replay:${intake.intakeId}`}>Replay</Button>}</div>)}</div>}
    </CardContent></Card>
  </div>
}
