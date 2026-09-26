"use client"

import * as React from "react"
import { Mail, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RequestError, requestJson } from "@/lib/mca/client"
import { validateApplicationInvitation } from "@/lib/mca/invitations-validation"
import type { ApplicationInvitation, FormBranding } from "@/lib/mca/applications/contracts"
import { InvitationsTable } from "./invitations-table"
import { DEFAULT_OPTIONAL_FIELDS, type OptionalFieldKey } from "@/lib/mca/applications/form-schema"

interface ApplicationsData { invitations: ApplicationInvitation[]; forms: { id: string; name: string; provider?: string }[]; canCreate: boolean; canManageForm?: boolean; invitationEmailEnabled: boolean }

export function ApplicationsWorkspace() {
  const [data, setData] = React.useState<ApplicationsData | null>(null)
  const [error, setError] = React.useState("")
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({})
  const [notice, setNotice] = React.useState("")
  const [busy, setBusy] = React.useState<string | null>(null)
  const [manualLink, setManualLink] = React.useState<{ id: string; url: string } | null>(null)
  const [branding, setBranding] = React.useState<FormBranding | null>(null)
  const createKey = React.useRef<string | null>(null)
  const sendKeys = React.useRef(new Map<string, string>())
  const refresh = React.useCallback(async () => {
    try { setData(await requestJson<ApplicationsData>("/api/mca/applications")) }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load applications. Try refreshing.") }
  }, [])
  React.useEffect(() => { void refresh() }, [refresh])
  React.useEffect(() => {
    void requestJson<{ branding: FormBranding }>("/api/mca/applications/form-settings").then(result => setBranding(result.branding)).catch(() => setBranding(null))
  }, [])
  React.useEffect(() => {
    // Refresh while visible so opens/submissions appear even when no email job is running.
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh() }, 15000)
    return () => clearInterval(timer)
  }, [refresh])

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget, fields = new FormData(form)
    const nextErrors = validateApplicationInvitation({ clientName: fields.get("clientName"), email: fields.get("email") })
    if (Object.keys(nextErrors).length) {
      setFieldErrors(nextErrors)
      setError("Review the highlighted fields.")
      return
    }
    setBusy("create"); setError(""); setFieldErrors({}); setNotice("")
    createKey.current ??= crypto.randomUUID()
    try {
      await requestJson("/api/mca/applications", { method: "POST", body: JSON.stringify({ clientName: fields.get("clientName"), email: fields.get("email"), integrationId: fields.get("integrationId"), requestKey: createKey.current }) })
      createKey.current = null; form.reset()
      setNotice(data?.invitationEmailEnabled
        ? "Invitation created. Send the email or copy the client’s link below."
        : "Invitation created. Copy the link to share with your client.")
      await refresh()
    } catch (reason) {
      setFieldErrors(reason instanceof RequestError ? reason.fieldErrors ?? {} : {})
      setError(reason instanceof Error ? reason.message : "Could not create the invitation. Try again.")
    }
    finally { setBusy(null) }
  }
  async function send(row: ApplicationInvitation) {
    setBusy(row.id); setError(""); setNotice("")
    const requestKey = sendKeys.current.get(row.id) ?? crypto.randomUUID()
    sendKeys.current.set(row.id, requestKey)
    try {
      await requestJson(`/api/mca/applications/${row.id}/send`, { method: "POST", body: JSON.stringify({ requestKey }) })
      sendKeys.current.delete(row.id)
      setNotice(`Email queued for ${row.clientName}. Delivery status will update here.`)
      await refresh()
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not queue the email. Try again.") }
    finally { setBusy(null) }
  }
  async function reconcile(row: ApplicationInvitation, deliveryId: string, outcome: "accepted" | "not_sent", evidence: string) {
    setBusy(row.id); setError(""); setNotice("")
    try {
      await requestJson(`/api/mca/applications/${row.id}/reconcile`, { method: "POST", body: JSON.stringify({ deliveryId, outcome, evidence }) })
      setNotice(outcome === "accepted" ? "Provider acceptance recorded. No email was sent again." : "Provider absence recorded. The same delivery was queued for retry.")
      await refresh()
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not reconcile the delivery.") }
    finally { setBusy(null) }
  }
  async function saveBranding(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const optionalFields = {
      dbaName: fields.get("opt-dbaName") === "on",
      fundingPurpose: fields.get("opt-fundingPurpose") === "on",
      naicsCode: fields.get("opt-naicsCode") === "on",
      ficoScore: fields.get("opt-ficoScore") === "on",
      driversLicense: fields.get("opt-driversLicense") === "on",
      voidedCheck: fields.get("opt-voidedCheck") === "on",
    }
    setBusy("branding"); setError("")
    try {
      const result = await requestJson<{ branding: FormBranding }>("/api/mca/applications/form-settings", { method: "PATCH", body: JSON.stringify({ welcomeTitle: fields.get("welcomeTitle"), welcomeBody: fields.get("welcomeBody"), thankYouTitle: fields.get("thankYouTitle"), optionalFields }) })
      setBranding(result.branding)
      setNotice("Application form updated.")
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the form.") }
    finally { setBusy(null) }
  }
  async function copy(row: ApplicationInvitation) {
    setBusy(row.id); setError(""); setNotice("")
    try {
      const { url } = await requestJson<{ url: string }>(`/api/mca/applications/${row.id}/link`, { method: "POST" })
      try { await navigator.clipboard.writeText(url); setNotice(`Application link copied for ${row.clientName}.`) }
      catch { setManualLink({ id: row.id, url }); setNotice("Select and copy the link below.") }
      await refresh()
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not copy the link. Try again.") }
    finally { setBusy(null) }
  }

  return <div className="space-y-7 px-4 lg:px-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold tracking-tight">Applications</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Invite a client to apply for funding. Follow their progress from your first email to their completed application.</p></div>
      <Button variant="outline" onClick={() => { setError(""); void refresh() }}><RefreshCw className="size-4" />Refresh</Button>
    </div>
    {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>}
    {notice && <div role="status" className="rounded-lg border bg-muted/40 p-4 text-sm">{notice}</div>}
    {!data && !error && <p role="status" className="py-8 text-sm text-muted-foreground">Loading applications…</p>}
    {data && <>
      <section className="rounded-xl border bg-card p-5" aria-labelledby="new-application-title">
        <h2 id="new-application-title" className="font-semibold">Invite a client</h2>
        <p className="mt-1 text-sm text-muted-foreground">Each invitation has its own link, assigned to you and valid for 30 days.</p>
        {!data.canCreate ? <p className="mt-4 text-sm">Creating invitations is disabled for your account. Contact your administrator.</p> : !data.forms.length ? <p className="mt-4 text-sm">Your company has no enabled application form yet. Refresh, or ask an administrator to check Application Intake.</p> : <form noValidate onSubmit={create} onChange={() => { createKey.current = null }} className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_auto] xl:items-end">
          <div className="space-y-2"><Label htmlFor="clientName">Business name</Label><Input id="clientName" name="clientName" maxLength={150} autoComplete="organization" placeholder="Client or business name" disabled={busy === "create"} aria-required aria-invalid={Boolean(fieldErrors.clientName?.[0])} aria-describedby={fieldErrors.clientName?.[0] ? "clientName-error" : undefined} />{fieldErrors.clientName?.[0] && <p id="clientName-error" role="alert" className="text-xs text-destructive">{fieldErrors.clientName[0]}</p>}</div>
          <div className="space-y-2"><Label htmlFor="clientEmail">Email address</Label><Input id="clientEmail" name="email" maxLength={254} type="email" autoComplete="email" placeholder="client@example.com" disabled={busy === "create"} aria-required aria-invalid={Boolean(fieldErrors.email?.[0])} aria-describedby={fieldErrors.email?.[0] ? "clientEmail-error" : undefined} />{fieldErrors.email?.[0] && <p id="clientEmail-error" role="alert" className="text-xs text-destructive">{fieldErrors.email[0]}</p>}</div>
          {data.forms.length > 1 ? <div className="space-y-2"><Label htmlFor="applicationForm">Application form</Label><select id="applicationForm" name="integrationId" className="h-9 w-full rounded-md border bg-background px-3 text-sm" disabled={busy === "create"}>{data.forms.map(form => <option key={form.id} value={form.id}>{form.name}</option>)}</select></div> : <input type="hidden" name="integrationId" value={data.forms[0].id} />}
          <Button disabled={busy !== null} type="submit"><Plus className="size-4" />{busy === "create" ? "Creating…" : "Create invitation"}</Button>
        </form>}
      </section>
      <section aria-labelledby="invitation-list-title">
        <div className="mb-4 flex items-baseline justify-between gap-3"><h2 id="invitation-list-title" className="text-lg font-semibold">Client invitations</h2><span className="text-sm tabular-nums text-muted-foreground">{data.invitations.length} total</span></div>
        {!data.invitationEmailEnabled && <p role="status" className="mb-4 rounded-lg border bg-muted/40 p-3 text-sm">Application emails are not enabled yet. Copy the link to share with your client.</p>}
        {!data.invitations.length ? <div className="rounded-xl border border-dashed px-6 py-12 text-center"><Mail className="mx-auto mb-3 size-7 text-muted-foreground" /><p className="font-medium">Your next application starts here</p><p className="mt-1 text-sm text-muted-foreground">Create an invitation above, then {data.invitationEmailEnabled ? "send your client their personal link." : "copy the link for your client."}</p></div> : <InvitationsTable invitations={data.invitations} canCreate={data.canCreate} canReconcile={data.canManageForm === true && data.canCreate} invitationEmailEnabled={data.invitationEmailEnabled} busy={busy} onCopy={row => void copy(row)} onSend={row => void send(row)} onReconcile={(row, deliveryId, outcome, evidence) => void reconcile(row, deliveryId, outcome, evidence)} manualLink={manualLink} />}
        <p className="mt-4 max-w-3xl text-xs leading-relaxed text-muted-foreground">Opens are observed visits and may include automated link scanners. Started means the client clicked “Start application”; it does not measure completed fields. Copied links do not count as emails sent. Incomplete applications keep their progress{data.invitationEmailEnabled ? " and receive reminder emails." : "."}</p>
      </section>
      {data.canManageForm && branding && <section className="rounded-xl border bg-card p-5" aria-labelledby="form-branding-title">
        <h2 id="form-branding-title" className="font-semibold">Fundlane application form</h2>
        <p className="mt-1 text-sm text-muted-foreground">Brokers send this form by default. Customize the welcome copy and optional steps. Jotform stays available only if it is still connected.</p>
        <form className="mt-5 grid gap-4 md:grid-cols-2" onSubmit={event => void saveBranding(event)}>
          <div className="space-y-2 md:col-span-2"><Label htmlFor="welcomeTitle">Welcome title</Label><Input id="welcomeTitle" name="welcomeTitle" defaultValue={branding.welcomeTitle} maxLength={120} /></div>
          <div className="space-y-2 md:col-span-2"><Label htmlFor="welcomeBody">Welcome message</Label><Input id="welcomeBody" name="welcomeBody" defaultValue={branding.welcomeBody} maxLength={600} /></div>
          <div className="space-y-2 md:col-span-2"><Label htmlFor="thankYouTitle">Thank-you title</Label><Input id="thankYouTitle" name="thankYouTitle" defaultValue={branding.thankYouTitle} maxLength={120} /></div>
          <fieldset className="md:col-span-2"><legend className="mb-2 text-sm font-medium">Include these steps</legend><div className="flex flex-wrap gap-4 text-sm">{([["dbaName","DBA"],["fundingPurpose","Funding purpose"],["naicsCode","NAICS"],["ficoScore","FICO"],["driversLicense","ID"],["voidedCheck","Voided check"]] as Array<[OptionalFieldKey, string]>).map(([key, label]) => <label key={key} className="flex items-center gap-2"><input type="checkbox" name={`opt-${key}`} defaultChecked={branding.optionalFields[key] ?? DEFAULT_OPTIONAL_FIELDS[key]} />{label}</label>)}</div></fieldset>
          <Button disabled={busy !== null} type="submit">{busy === "branding" ? "Saving…" : "Save form"}</Button>
        </form>
      </section>}
    </>}
  </div>
}
