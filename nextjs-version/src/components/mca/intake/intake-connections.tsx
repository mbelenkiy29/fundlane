"use client"

import * as React from "react"
import { Check, Copy, Loader2, Plus, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import type { IntegrationInput, IntegrationStatus } from "@/lib/mca/intake/configuration"
import { IntakePanel } from "./intake-panel"
import { intakeRequest, providerNames } from "./intake-workspace"

type Member = { membershipId: string; name: string }
const providers = ["jotform", "highlevel", "zoho", "custom"] as const
const fields = [
  ["legalName", "Business legal name"], ["requestedAmount", "Requested amount"], ["monthlyRevenue", "Monthly revenue"],
  ["contactEmail", "Contact email"], ["contactPhone", "Contact phone"], ["ein", "Business tax ID"],
  ["startDate", "Business start date"], ["industry", "Industry"], ["entityType", "Business entity type"], ["ficoScore", "Credit score"],
  ["address.state", "Business state"], ["owners.0.firstName", "Owner first name"], ["owners.0.lastName", "Owner last name"],
  ["owners.0.ownershipPercent", "Ownership percentage"], ["files:application", "Application document field"], ["files:statement", "Bank statements field"],
] as const
const defaults = Object.fromEntries(fields.filter(([key]) => !key.startsWith("files:")).map(([key]) => [key,key]))
const instructions: Record<string,string> = {
  jotform: "Use the Jotform Workflow webhook that supports an Authorization header. Send the form ID, submission ID, and rawRequest fields. Map upload fields below so application documents and bank statements are categorized correctly.",
  highlevel: "Use the existing signed GoHighLevel event contract with locationId and webhookId. Signature verification must be configured on the server. Map custom fields using customFields.FIELD_ID.",
  zoho: "Use the Zoho flat JSON contract with formId and entryId. Send applicationFile and statementFile as private Google Drive links. Provide a Drive read token and its expiry.",
  custom: "Send JSON with formId, eventId, application, and attachments. Give every attachment a stable id, URL, filename, and category: application or statement. Your server sends the Authorization header.",
}
function example(provider: string, binding: string) {
  const application = { legalName: "Bayside Diner", requestedAmount: 75000, monthlyRevenue: 142000, contactEmail: "merchant@example.test" }
  if (provider === "jotform") return { formID: binding, submissionID: "preview-application", rawRequest: JSON.stringify(application), attachments: [] }
  if (provider === "highlevel") return { locationId: binding, webhookId: "preview-application", ...application, attachments: [] }
  if (provider === "zoho") return { formId: binding, entryId: "preview-application", ...application }
  return { formId: binding, eventId: "preview-application", application, attachments: [] }
}

export function IntakeConnections() {
  const [connections, setConnections] = React.useState<IntegrationStatus[]>([])
  const [members, setMembers] = React.useState<Member[]>([])
  const [loading, setLoading] = React.useState(true)
  const [editing, setEditing] = React.useState(false)
  const [step, setStep] = React.useState(0)
  const [id, setId] = React.useState<string>()
  const [provider, setProvider] = React.useState<IntegrationInput["provider"]>("jotform")
  const [name, setName] = React.useState("")
  const [binding, setBinding] = React.useState("")
  const [credential, setCredential] = React.useState("")
  const [expiry, setExpiry] = React.useState("")
  const [pool, setPool] = React.useState<string[]>([])
  const [mapping, setMapping] = React.useState<Record<string,string>>(defaults)
  const [hosts, setHosts] = React.useState("www.jotform.com, api.jotform.com")
  const [initialStatus, setInitialStatus] = React.useState("new_application")
  const [automatic, setAutomatic] = React.useState(true)
  const [payload, setPayload] = React.useState("")
  const [preview, setPreview] = React.useState<{ application: Record<string,unknown>; attachments: Array<{ filename: string; category: string }> }>()
  const [secret, setSecret] = React.useState("")
  const [advanced, setAdvanced] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  async function load() {
    try { const data = await intakeRequest<{ integrations: IntegrationStatus[]; members: Member[] }>("/api/mca/intake/integrations"); setConnections(data.integrations); setMembers(data.members) }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load connections.") }
    finally { setLoading(false) }
  }
  React.useEffect(() => { void load() }, [])
  function start(connection?: IntegrationStatus) {
    setId(connection?.id); setProvider((connection?.provider as IntegrationInput["provider"]) ?? "jotform")
    setName(connection?.displayName ?? ""); setBinding(connection?.binding ?? ""); setCredential(""); setExpiry("")
    setPool(connection?.assignmentPool ?? []); setMapping(connection ? connection.mapping : defaults)
    setHosts(connection?.allowedHosts.join(", ") ?? "www.jotform.com, api.jotform.com")
    setInitialStatus(connection?.initialStatus ?? "new_application"); setAutomatic(connection?.automaticProcessing ?? true)
    setPreview(undefined); setSecret(""); setAdvanced(""); setPayload(""); setError(""); setNotice(""); setStep(0); setEditing(true)
  }
  async function save(enabled: boolean) {
    const overrides = advanced.trim() ? JSON.parse(advanced) as Record<string,string> : {}
    if (!overrides || Array.isArray(overrides) || typeof overrides !== "object" || Object.values(overrides).some(v => typeof v !== "string")) throw new Error("Advanced mappings must contain field names and source paths.")
    const body = { id, provider, displayName: name, ...(provider === "highlevel" ? { locationId: binding } : { formId: binding }),
      credential: credential || undefined, credentialExpiresAt: expiry ? new Date(expiry).toISOString() : undefined,
      assignmentPool: pool, initialStatus, automaticProcessing: enabled && automatic, enabled,
      mapping: { ...Object.fromEntries(Object.entries(mapping).filter(([,path]) => path.trim())), ...overrides },
      allowedHosts: hosts.split(",").map(h => h.trim()).filter(Boolean),
    }
    const result = await intakeRequest<{ status: IntegrationStatus; admissionSecret?: string }>("/api/mca/intake/integrations", { method: "POST", body: JSON.stringify(body) })
    setId(result.status.id); if (result.admissionSecret) setSecret(result.admissionSecret)
    return result.status
  }
  async function testMapping() {
    setBusy(true); setError(""); setPreview(undefined)
    try {
      const parsed = JSON.parse(payload)
      // Existing live connections are never disabled just to preview their mapping.
      const connection = await save(Boolean(id && connections.find(c => c.id === id)?.enabled))
      const result = await intakeRequest<{ application: Record<string,unknown>; attachments: Array<{ filename: string; category: string }> }>(`/api/mca/intake/integrations/${connection.id}/preview`, { method: "POST", body: JSON.stringify(parsed) })
      if (!result.application.legalName) throw new Error("The business name was not mapped. Go back to Field mapping and choose the correct source field.")
      setPreview(result)
    } catch(e) { setError(e instanceof Error ? e.message : "Preview failed.") }
    finally { setBusy(false) }
  }
  async function activate() {
    setBusy(true); setError("")
    try { await save(true); setNotice("Connection saved. Send a real test application from your form to verify delivery. Automatic analysis ends at rep review."); await load(); setStep(4) }
    catch(e) { setError(e instanceof Error ? e.message : "Could not save the connection.") }
    finally { setBusy(false) }
  }
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); setNotice("Copied to clipboard.") } catch { setError("Clipboard access is unavailable. Select and copy the value below.") } }
  const webhook = id && typeof window !== "undefined" ? `${window.location.origin}/api/mca/intake/providers/${provider}/${id}` : ""
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Application form connections</h2><p className="mt-1 text-sm text-muted-foreground">Choose where applications arrive and who receives them.</p></div>{!editing && <Button onClick={() => start()}><Plus className="size-4" />Connect a form</Button>}</div>
    {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="rounded-md border p-3 text-sm">{notice}</p>}
    {editing ? <section className="rounded-xl border bg-card p-5 md:p-7">
      <ol aria-label="Connection setup" className="mb-7 flex flex-wrap gap-x-6 gap-y-2 text-sm">{["Form source", "Assign applications", "Field mapping", "Preview and connect"].map((label,index) => <li key={label} aria-current={step === index ? "step" : undefined} className={step === index ? "font-semibold text-primary" : "text-muted-foreground"}>{index < step ? <Check className="mr-1 inline size-4" /> : `${index+1}. `}{label}</li>)}</ol>
      {step === 0 && <div className="max-w-2xl space-y-5"><div><Label htmlFor="connection-provider">Application form provider</Label><select id="connection-provider" disabled={Boolean(id)} value={provider} onChange={e => { setProvider(e.target.value as IntegrationInput["provider"]); setHosts(e.target.value === "jotform" ? "www.jotform.com, api.jotform.com" : e.target.value === "zoho" ? "www.googleapis.com" : "") }} className="mt-2 h-10 w-full rounded-md border bg-background px-3">{providers.map(p => <option key={p} value={p}>{providerNames[p]}</option>)}</select></div><p className="text-sm leading-relaxed text-muted-foreground">{instructions[provider]}</p><div><Label htmlFor="connection-name">Connection name</Label><Input id="connection-name" className="mt-2" value={name} onChange={e => setName(e.target.value)} placeholder="Main merchant application" /></div><div><Label htmlFor="connection-binding">{provider === "highlevel" ? "Location ID" : "Form ID"}</Label><Input id="connection-binding" className="mt-2" value={binding} onChange={e => setBinding(e.target.value)} /></div><div><Label htmlFor="connection-credential">{provider === "zoho" ? "Google Drive read token" : "Private attachment read credential"}</Label><Input id="connection-credential" className="mt-2" type="password" autoComplete="off" value={credential} onChange={e => setCredential(e.target.value)} placeholder={id ? "Leave blank to keep the saved credential" : "Used only to retrieve private files"} /></div>{provider === "zoho" && <div><Label htmlFor="connection-expiry">Token expires at</Label><Input id="connection-expiry" className="mt-2" type="datetime-local" value={expiry} onChange={e => setExpiry(e.target.value)} /></div>}</div>}
      {step === 1 && <div className="max-w-2xl space-y-5"><h3 className="font-medium">Choose a fallback rep or team</h3><p className="text-sm text-muted-foreground">Personal rep links and mapped provider reps take priority. Otherwise, applications go to your selected rep or are distributed consistently across the selected team.</p><fieldset className="space-y-2"><legend className="sr-only">Active team members</legend>{members.map(member => <label key={member.membershipId} className="flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 text-sm"><input type="checkbox" checked={pool.includes(member.membershipId)} onChange={e => setPool(e.target.checked ? [...pool,member.membershipId] : pool.filter(p => p !== member.membershipId))} />{member.name}</label>)}{!members.length && <p className="text-sm text-muted-foreground">Add an active team member in Settings before connecting a form.</p>}</fieldset><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={automatic} onChange={e => setAutomatic(e.target.checked)} /><span>Automatically analyze statements and prepare funder matches.<span className="mt-1 block text-muted-foreground">A rep always reviews the deal before sending it to funders.</span></span></label></div>}
      {step === 2 && <div className="space-y-5"><p className="max-w-2xl text-sm text-muted-foreground">Match the fields in your form to the deal. Enter each form field’s name or nested path. Leave fields blank when your form does not collect them.</p><div className="grid gap-4 sm:grid-cols-2">{fields.filter(([key]) => provider !== "zoho" || !key.startsWith("files:")).map(([key,label]) => <div key={key}><Label htmlFor={`mapping-${key}`}>{label}</Label><Input className="mt-2" id={`mapping-${key}`} value={mapping[key] ?? ""} placeholder={key.startsWith("files:") ? "Upload field name" : key} onChange={e => setMapping({...mapping,[key]:e.target.value})} /></div>)}</div><details className="rounded-md border p-4"><summary className="cursor-pointer text-sm font-medium">Advanced connection settings</summary><div className="mt-4 space-y-4"><div><Label htmlFor="attachment-hosts">Allowed private file hosts</Label><Input id="attachment-hosts" className="mt-2" value={hosts} onChange={e => setHosts(e.target.value)} placeholder="uploads.example.com" /></div><div><Label htmlFor="initial-status">New deal status</Label><select id="initial-status" className="mt-2 h-10 w-full rounded-md border bg-background px-3" value={initialStatus} onChange={e => setInitialStatus(e.target.value)}><option value="lead">Lead</option><option value="new_application">New application</option><option value="missing_documents">Missing documents</option></select></div><div><Label htmlFor="advanced-map">Additional field and rep mappings (JSON)</Label><Textarea id="advanced-map" className="mt-2" rows={4} value={advanced} onChange={e => setAdvanced(e.target.value)} placeholder={'{"rep:external-user-id":"member-id"}'} /></div></div></details></div>}
      {step === 3 && <div className="space-y-4"><p className="max-w-2xl text-sm text-muted-foreground">Paste an example submission from your form, or use this synthetic sample. Preview saves the connection configuration, but does not create a deal or retrieve files.</p><Label htmlFor="preview-payload">Example submission</Label><Textarea id="preview-payload" value={payload} onChange={e => { setPayload(e.target.value); setPreview(undefined) }} rows={9} spellCheck={false} /><Button variant="outline" disabled={busy} onClick={() => void testMapping()}>{busy && <Loader2 className="size-4 animate-spin" />}Save and preview mapping</Button>{preview && <div className="rounded-md border bg-muted/30 p-4"><h3 className="font-medium">Mapped application: {String(preview.application.legalName)}</h3><p className="mt-1 text-sm text-muted-foreground">{preview.attachments.length} document references. This preview does not verify live provider access.</p><details className="mt-3"><summary className="cursor-pointer text-sm">Review mapped fields and files</summary><pre className="mt-2 max-h-72 overflow-auto text-xs">{JSON.stringify(preview,null,2)}</pre></details></div>}</div>}
      {step === 4 && <div className="space-y-3"><h3 className="text-lg font-semibold">Ready for a real test application</h3><p className="max-w-2xl text-sm text-muted-foreground">Configure the URL and authentication below in your form provider, then submit a test application with an application document and the required bank statements. Follow its progress in Applications.</p></div>}
      {webhook && step >= 3 && <div className="mt-5 space-y-3 rounded-md border p-4"><Label htmlFor="intake-webhook-url">Provider webhook URL</Label><div className="flex gap-2"><Input id="intake-webhook-url" readOnly value={webhook} /><Button variant="outline" size="icon" aria-label="Copy webhook URL" onClick={() => void copy(webhook)}><Copy className="size-4" /></Button></div>{secret && <><Label htmlFor="intake-auth-header">Authorization header — save this secret now</Label><div className="flex gap-2"><Input id="intake-auth-header" readOnly type="password" value={`Bearer ${secret}`} /><Button variant="outline" size="icon" aria-label="Copy authorization header" onClick={() => void copy(`Bearer ${secret}`)}><Copy className="size-4" /></Button></div></>}{provider === "highlevel" && <p className="text-sm text-muted-foreground">GoHighLevel uses the existing Ed25519 signature verification configuration.</p>}</div>}
      <div className="mt-7 flex flex-wrap justify-between gap-3 border-t pt-5"><Button variant="ghost" disabled={busy} onClick={() => { setEditing(false); setSecret(""); void load() }}>{step === 4 ? "Done" : "Close setup"}</Button><div className="flex gap-2">{step > 0 && step < 4 && <Button variant="outline" disabled={busy} onClick={() => { setStep(step-1); setPreview(undefined) }}>Back</Button>}{step < 3 && <Button disabled={step === 0 ? !name.trim() || !binding.trim() : step === 1 ? !pool.length : false} onClick={() => { if(step === 2) setPayload(JSON.stringify(example(provider,binding),null,2)); setStep(step+1) }}>Continue</Button>}{step === 3 && <Button disabled={!preview || busy || !pool.length} onClick={() => void activate()}>{busy && <Loader2 className="size-4 animate-spin" />}Enable connection</Button>}</div></div>
    </section> : loading ? <p role="status" className="py-10 text-sm text-muted-foreground">Loading connections…</p> : <div className="divide-y rounded-xl border">{connections.filter(c => providers.includes(c.provider as typeof providers[number])).map(c => <div key={c.id} className="flex flex-wrap items-center justify-between gap-4 p-5"><div><h3 className="font-medium">{c.displayName}</h3><p className="mt-1 text-sm text-muted-foreground">{providerNames[c.provider]} · {c.automaticProcessing ? "Automatic analysis" : "Manual processing"} · {c.assignmentPool.length} fallback rep{c.assignmentPool.length === 1 ? "" : "s"}</p><div className="mt-2 flex flex-wrap gap-2"><Badge variant="outline">{c.enabled ? "Configuration saved" : "Disabled / draft"}</Badge><Badge variant="secondary">{c.lastDeliveryAt ? "Application received" : "Live delivery unverified"}</Badge>{c.credential === "expired" && <Badge variant="destructive">Read credential expired</Badge>}</div></div><Button variant="outline" size="sm" onClick={() => start(c)}><Settings2 className="size-4" />Configure</Button></div>)}{!connections.some(c => providers.includes(c.provider as typeof providers[number])) && <p className="p-8 text-center text-sm text-muted-foreground">No application forms connected yet. Connect your first form to get started.</p>}</div>}
    <details className="rounded-md border p-4"><summary className="cursor-pointer text-sm font-medium">Advanced integrations, credential rotation, and personal rep links</summary><div className="mt-5"><IntakePanel /></div></details>
  </div>
}
