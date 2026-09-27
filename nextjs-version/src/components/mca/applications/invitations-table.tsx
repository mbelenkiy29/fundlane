"use client"

import * as React from "react"
import Link from "next/link"
import { Copy, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { ApplicationInvitation } from "@/lib/mca/applications/contracts"
import { invitationStatus } from "./invitation-status"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : "—"
const day = (value: string | null) => value ? new Date(value).toLocaleDateString() : "—"

type SortKey = "businessName" | "requestedAmountCents" | "sentAt" | "openedAt" | "startedAt" | "submittedAt" | "createdAt"

export function InvitationsTable({
  invitations, canCreate, canReconcile = false, invitationEmailEnabled = true, busy, onCopy, onSend, onReconcile, manualLink,
}: {
  invitations: ApplicationInvitation[]
  canCreate: boolean
  canReconcile?: boolean
  invitationEmailEnabled?: boolean
  busy: string | null
  onCopy: (row: ApplicationInvitation) => void
  onSend: (row: ApplicationInvitation) => void
  onReconcile: (row: ApplicationInvitation, deliveryId: string, outcome: "accepted" | "not_sent", evidence: string) => void
  manualLink: { id: string; url: string } | null
}) {
  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState("all")
  const [sort, setSort] = React.useState<SortKey>("createdAt")
  const [desc, setDesc] = React.useState(true)
  const [open, setOpen] = React.useState<ApplicationInvitation | null>(null)
  const [evidence, setEvidence] = React.useState("")
  const [outcome, setOutcome] = React.useState<"accepted" | "not_sent">("accepted")
  const selected = open ? invitations.find(row => row.id === open.id) ?? open : null
  const rows = invitations.filter(row => {
    const hay = `${row.businessName} ${row.clientName} ${row.email} ${row.employeeName}`.toLowerCase()
    if (query && !hay.includes(query.toLowerCase())) return false
    if (status === "incomplete") return Boolean(row.openedAt && !row.submittedAt)
    if (status === "completed") return Boolean(row.submittedAt)
    if (status === "sent") return Boolean(row.sentAt && !row.submittedAt)
    return true
  }).sort((left, right) => {
    const a = left[sort], b = right[sort]
    const cmp = typeof a === "number" || typeof b === "number"
      ? (Number(a ?? -1) - Number(b ?? -1))
      : String(a ?? "").localeCompare(String(b ?? ""))
    return desc ? -cmp : cmp
  })
  function header(key: SortKey, label: string) {
    return <th className="cursor-pointer px-3 py-3 text-left text-xs font-medium text-muted-foreground" onClick={() => { if (sort === key) setDesc(!desc); else { setSort(key); setDesc(true) } }}>{label}</th>
  }
  return <div>
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <Input className="max-w-xs" placeholder="Search business, email, or rep" value={query} onChange={event => setQuery(event.target.value)} />
      <select className="h-9 rounded-md border bg-background px-3 text-sm" value={status} onChange={event => setStatus(event.target.value)} aria-label="Filter invitations">
        <option value="all">All statuses</option>
        <option value="sent">Sent, not completed</option>
        <option value="incomplete">Opened, not completed</option>
        <option value="completed">Completed</option>
      </select>
    </div>
    {!invitations.length ? null : !rows.length ? <p className="py-8 text-sm text-muted-foreground">No invitations match these filters.</p> : <div className="overflow-auto rounded-xl border bg-card">
      <table className="w-full min-w-[960px] text-sm">
        <thead className="sticky top-0 bg-background/90 backdrop-blur-sm">
          <tr>
            {header("businessName", "Business name")}
            <th className="px-3 py-3 text-left text-xs font-medium text-muted-foreground">Email</th>
            {header("requestedAmountCents", "$ requested")}
            <th className="px-3 py-3 text-left text-xs font-medium text-muted-foreground">Status</th>
            {header("sentAt", "Date sent")}
            {header("openedAt", "Date opened")}
            {header("startedAt", "Date started")}
            {header("submittedAt", "Date completed")}
            <th className="px-3 py-3 text-left text-xs font-medium text-muted-foreground">Employee</th>
            <th className="px-3 py-3 text-right text-xs font-medium text-muted-foreground">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const latest = row.deliveries[0]
            const pending = latest?.state === "queued" || latest?.state === "running"
            const reconcile = latest?.requiresReconciliation === true
            return <tr key={row.id} className="cursor-pointer border-t hover:bg-muted/40" onClick={() => setOpen(row)}>
              <td className="px-3 py-3 font-medium">{row.businessName}</td>
              <td className="max-w-[14rem] truncate px-3 py-3 text-muted-foreground">{row.email}</td>
              <td className="px-3 py-3 tabular-nums">{row.requestedAmountCents == null ? "—" : money.format(row.requestedAmountCents / 100)}</td>
              <td className="px-3 py-3"><Badge variant={row.submittedAt ? "default" : "secondary"}>{invitationStatus(row)}</Badge></td>
              <td className="px-3 py-3 tabular-nums text-muted-foreground">{day(row.sentAt)}</td>
              <td className="px-3 py-3 tabular-nums text-muted-foreground">{day(row.openedAt)}</td>
              <td className="px-3 py-3 tabular-nums text-muted-foreground">{day(row.startedAt)}</td>
              <td className="px-3 py-3 tabular-nums text-muted-foreground">{day(row.submittedAt)}</td>
              <td className="px-3 py-3 text-muted-foreground">{row.employeeName}</td>
              <td className="px-3 py-3 text-right" onClick={event => event.stopPropagation()}>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" disabled={busy !== null || !row.active || !canCreate} onClick={() => onCopy(row)}><Copy className="size-3.5" />Copy</Button>
                  <Button size="sm" disabled={busy !== null || (!reconcile && (pending || !row.active || !canCreate || !invitationEmailEnabled))} title={!reconcile && !invitationEmailEnabled ? "Application emails are not enabled yet. Copy the link instead." : undefined} onClick={() => reconcile ? setOpen(row) : onSend(row)}><Send className="size-3.5" />{reconcile ? "Review delivery" : pending ? "Sending…" : latest?.state === "failed" ? "Retry" : row.sentAt ? "Resend" : "Send"}</Button>
                </div>
              </td>
            </tr>
          })}
        </tbody>
      </table>
    </div>}
    <Sheet open={Boolean(open)} onOpenChange={value => { if (!value) { setOpen(null); setEvidence(""); setOutcome("accepted") } }}>
      <SheetContent className="sm:max-w-md" side="right">
        {selected && <div className="flex h-full flex-col">
          <SheetHeader><SheetTitle>{selected.businessName}</SheetTitle></SheetHeader>
          <div className="space-y-4 overflow-auto px-4 pb-6 text-sm">
            <p className="break-all text-muted-foreground">{selected.email}</p>
            <p>{selected.employeeName} · {selected.formName}</p>
            <Badge variant={selected.submittedAt ? "default" : "secondary"}>{invitationStatus(selected)}</Badge>
            {manualLink?.id === selected.id && <Input aria-label={`Application link for ${selected.clientName}`} value={manualLink.url} readOnly onFocus={event => event.target.select()} />}
            {selected.intakeError && <p role="alert" className="text-destructive">Application needs review: {selected.intakeError}</p>}
            {selected.deliveries[0]?.requiresReconciliation && <div className="space-y-3 rounded-md border p-3">
              <p>Delivery outcome is unknown. Check the email provider using correlation ID <code className="break-all">{selected.deliveries[0].id}</code> before another send.</p>
              {!canReconcile ? <p>Ask a company administrator with invitation access to reconcile this delivery.</p> : <>
                <select className="h-9 w-full rounded-md border bg-background px-3" aria-label="Provider outcome" value={outcome} onChange={event => setOutcome(event.target.value as "accepted" | "not_sent")}>
                  <option value="accepted">Provider accepted the email</option>
                  <option value="not_sent">Provider confirms no email was sent</option>
                </select>
                <Input aria-label="Provider receipt or lookup reference" placeholder="Provider receipt or lookup reference" maxLength={500} value={evidence} onChange={event => setEvidence(event.target.value)} />
                <Button disabled={busy !== null || evidence.trim().length < 10 || (outcome === "not_sent" && !selected.active)} onClick={() => onReconcile(selected, selected.deliveries[0].id, outcome, evidence.trim())}>Record provider outcome</Button>
              </>}
            </div>}
            <dl className="grid grid-cols-2 gap-3 text-xs">
              {[["Created", selected.createdAt], ["Email accepted", selected.sentAt], ["Opened", selected.openedAt], ["Started", selected.startedAt], ["Completed", selected.submittedAt], ["Expires", selected.expiresAt]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 tabular-nums">{stamp(value)}</dd></div>)}
              <div><dt className="text-muted-foreground">Requested</dt><dd className="mt-1 tabular-nums">{selected.requestedAmountCents == null ? "—" : money.format(selected.requestedAmountCents / 100)}</dd></div>
            </dl>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>Created {stamp(selected.createdAt)}</li>
              {selected.copiedAt && <li>Link copied {stamp(selected.copiedAt)}</li>}
              {selected.deliveries.map(delivery => <li key={delivery.id}>{stamp(delivery.createdAt)} — {delivery.delivery === "sent" ? "Email accepted" : delivery.delivery === "preview" ? "Preview; not sent" : delivery.requiresReconciliation ? "Email outcome unknown; provider reconciliation required" : delivery.state === "failed" ? "Email failed; retry available" : "Email queued / sending"}</li>)}
              {selected.openedAt && <li>First observed visit {stamp(selected.openedAt)}</li>}
              {selected.startedAt && <li>Start application clicked {stamp(selected.startedAt)}</li>}
              {selected.submittedAt && <li>Application received {stamp(selected.submittedAt)}</li>}
            </ul>
            {selected.dealId && <Link className="font-medium text-primary underline-offset-4 hover:underline" href={`/deals?deal=${encodeURIComponent(selected.dealId)}`}>View deal</Link>}
          </div>
        </div>}
      </SheetContent>
    </Sheet>
  </div>
}
