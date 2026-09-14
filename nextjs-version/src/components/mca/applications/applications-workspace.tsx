"use client"

import * as React from "react"
import Link from "next/link"
import { Copy, Mail, Plus, RefreshCw, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { requestJson } from "@/lib/mca/client"
import type { ApplicationInvitation } from "@/lib/mca/applications/contracts"

interface ApplicationsData { invitations: ApplicationInvitation[]; forms: { id: string; name: string }[]; canCreate: boolean }
const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : "—"

function invitationStatus(row: ApplicationInvitation): string {
  if (row.submittedAt) return "Application received"
  if (!row.active) return "Link inactive"
  if (!row.openedAt && !row.sentAt) {
    if (row.deliveries[0]?.state === "queued") return "Email queued"
    if (row.deliveries[0]?.state === "running") return "Sending email"
    if (row.deliveries[0]?.state === "failed") return "Email needs attention"
  }
  if (row.startedAt) return "Started, not submitted"
  if (row.openedAt) return "Opened, not submitted"
  if (row.sentAt) return "Email accepted"
  if (row.copiedAt) return "Link copied"
  return "Ready to send"
}

export function ApplicationsWorkspace() {
  const [data, setData] = React.useState<ApplicationsData | null>(null)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [busy, setBusy] = React.useState<string | null>(null)
  const [manualLink, setManualLink] = React.useState<{ id: string; url: string } | null>(null)
  const createKey = React.useRef<string | null>(null)
  const sendKeys = React.useRef(new Map<string, string>())
  const refresh = React.useCallback(async () => {
    try { setData(await requestJson<ApplicationsData>("/api/mca/applications")) }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load applications. Try refreshing.") }
  }, [])
  React.useEffect(() => { void refresh() }, [refresh])
  React.useEffect(() => {
    // Refresh while visible so opens/submissions appear even when no email job is running.
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh() }, 15000)
    return () => clearInterval(timer)
  }, [refresh])

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget, fields = new FormData(form)
    setBusy("create"); setError(""); setNotice("")
    createKey.current ??= crypto.randomUUID()
    try {
      await requestJson("/api/mca/applications", { method: "POST", body: JSON.stringify({ clientName: fields.get("clientName"), email: fields.get("email"), integrationId: fields.get("integrationId"), requestKey: createKey.current }) })
      createKey.current = null; form.reset()
      setNotice("Invitation created. Send the email or copy the client’s link below.")
      await refresh()
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create the invitation. Try again.") }
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
        {!data.canCreate ? <p className="mt-4 text-sm">Creating invitations is disabled for your account. Contact your administrator.</p> : !data.forms.length ? <p className="mt-4 text-sm">Your company has no enabled application form. Ask an administrator to connect Jotform in Settings → Connections.</p> : <form onSubmit={create} onChange={() => { createKey.current = null }} className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_auto] xl:items-end">
          <div className="space-y-2"><Label htmlFor="clientName">Client name</Label><Input id="clientName" name="clientName" required maxLength={150} autoComplete="name" placeholder="Client or business name" disabled={busy === "create"} /></div>
          <div className="space-y-2"><Label htmlFor="clientEmail">Email address</Label><Input id="clientEmail" name="email" required maxLength={254} type="email" autoComplete="email" placeholder="client@example.com" disabled={busy === "create"} /></div>
          <div className="space-y-2"><Label htmlFor="applicationForm">Application form</Label><select id="applicationForm" name="integrationId" className="h-9 w-full rounded-md border bg-background px-3 text-sm" disabled={busy === "create"}>{data.forms.map(form => <option key={form.id} value={form.id}>{form.name}</option>)}</select></div>
          <Button disabled={busy !== null} type="submit"><Plus className="size-4" />{busy === "create" ? "Creating…" : "Create invitation"}</Button>
        </form>}
      </section>
      <section aria-labelledby="invitation-list-title">
        <div className="mb-4 flex items-baseline justify-between gap-3"><h2 id="invitation-list-title" className="text-lg font-semibold">Client invitations</h2><span className="text-sm tabular-nums text-muted-foreground">{data.invitations.length} total</span></div>
        {!data.invitations.length ? <div className="rounded-xl border border-dashed px-6 py-12 text-center"><Mail className="mx-auto mb-3 size-7 text-muted-foreground" /><p className="font-medium">Your next application starts here</p><p className="mt-1 text-sm text-muted-foreground">Create an invitation above, then send your client their personal link.</p></div> : <div className="divide-y rounded-xl border bg-card">{data.invitations.map(row => {
          const latest = row.deliveries[0]
          const pending = latest?.state === "queued" || latest?.state === "running"
          return <article key={row.id} className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{row.clientName}</h3><Badge variant={row.submittedAt ? "default" : "secondary"}>{invitationStatus(row)}</Badge></div><p className="mt-1 break-all text-sm text-muted-foreground">{row.email}</p><p className="mt-2 text-xs text-muted-foreground">{row.employeeName} · {row.formName}</p></div>
              <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy !== null || !row.active || !data.canCreate} onClick={() => void copy(row)}><Copy className="size-3.5" />Copy link</Button><Button size="sm" disabled={busy !== null || pending || !row.active || !data.canCreate} onClick={() => void send(row)}><Send className="size-3.5" />{pending ? "Sending…" : latest?.state === "failed" ? "Retry email" : row.sentAt ? "Resend email" : "Send email"}</Button></div>
            </div>
            {manualLink?.id === row.id && <Input className="mt-3" aria-label={`Application link for ${row.clientName}`} value={manualLink.url} readOnly onFocus={event => event.target.select()} />}
            {latest?.state === "failed" && <p role="alert" className="mt-3 text-sm text-destructive">Email could not be confirmed. Retry to reconcile the same delivery. If it keeps failing, ask an administrator to check email setup.</p>}
            {latest?.delivery === "preview" && <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">Preview only. No email was sent. Copy the link to test the application.</p>}
            {row.intakeError && <p role="alert" className="mt-3 text-sm text-destructive">Application needs review: {row.intakeError}</p>}
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4 text-xs sm:grid-cols-3 xl:grid-cols-6">{[["Created", row.createdAt], ["Email accepted", row.sentAt], ["Link opened", row.openedAt], ["Started", row.startedAt], ["Application received", row.submittedAt], ["Link expires", row.expiresAt]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 tabular-nums">{stamp(value)}</dd></div>)}</dl>
            <div className="mt-4 flex flex-wrap items-start justify-between gap-3 text-sm">
              <details className="text-muted-foreground"><summary className="cursor-pointer">Activity history</summary><ul className="mt-2 space-y-1 text-xs"><li>Created {stamp(row.createdAt)}</li>{row.copiedAt && <li>Link copied {stamp(row.copiedAt)}</li>}{row.deliveries.map(delivery => <li key={delivery.id}>{stamp(delivery.createdAt)} — {delivery.delivery === "sent" ? "Email accepted" : delivery.delivery === "preview" ? "Preview; not sent" : delivery.state === "failed" ? "Email failed; retry available" : "Email queued / sending"}</li>)}{row.openedAt && <li>First observed visit {stamp(row.openedAt)}</li>}{row.startedAt && <li>Start application clicked {stamp(row.startedAt)}</li>}{row.submittedAt && <li>Application received {stamp(row.submittedAt)}</li>}</ul></details>
              {row.dealId && <Link className="font-medium text-primary underline-offset-4 hover:underline" href={`/deals?deal=${encodeURIComponent(row.dealId)}`}>View deal</Link>}
            </div>
          </article>
        })}</div>}
        <p className="mt-4 max-w-3xl text-xs leading-relaxed text-muted-foreground">Opens are observed visits and may include automated link scanners. Started means the client clicked “Start application”; it does not measure completed fields. Copied links do not count as emails sent.</p>
      </section>
    </>}
  </div>
}
