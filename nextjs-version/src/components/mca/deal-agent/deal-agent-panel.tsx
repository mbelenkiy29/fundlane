"use client"

import * as React from "react"
import { Bot } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { requestJson } from "@/lib/mca/client"
import type { DealAgentView } from "@/lib/mca/deal-agent/actions"
import type { EmailSender } from "@/lib/mca/senders/contracts"

type Action = DealAgentView["actions"][number]
type Step = { step: string; outcome: "ok" | "skipped" | "failed"; summary: string; code?: string }
type SubmissionPreview = { destinations: Array<{ funderId: string; name: string; method: string; destination: string; documents: Array<{ id: string; filename: string }>; email?: { to: string[]; subject: string } }> }
type RequestPreview = { recipientMasked: string; subject?: string; body: string }

const KIND_LABELS: Record<Action["kind"], string> = { request_documents: "Request missing documents", submit_to_funder: "Submit to funder", schedule_follow_up: "Schedule follow-up" }
const ERROR_NOTES: Record<string, string> = {
  interrupted: "This didn't finish. Review and approve again.",
  inputs_changed: "The deal changed since you reviewed this. Approving sends what you reviewed; review again to use the newer proposal.",
  no_longer_suggested: "The agent no longer suggests this. You can still approve what you reviewed, or dismiss it.",
}

function Reasons({ action }: { action: Action }) {
  const payload = action.payload as Record<string, unknown>
  if (action.kind === "submit_to_funder") {
    return <div className="space-y-1 text-sm"><p className="font-medium">{String(payload.name)} · rank {String(payload.rank)} · score {String(payload.score)}</p>
      <ul className="list-disc pl-5 text-muted-foreground">{(payload.reasons as string[]).map(reason => <li key={reason}>{reason}</li>)}</ul>
      <p className="text-xs text-muted-foreground">{String(payload.disclaimer)}</p></div>
  }
  if (action.kind === "request_documents") {
    return <div className="space-y-1 text-sm"><ul className="list-disc pl-5">{(payload.items as Array<{ code: string; label: string }>).map(item => <li key={item.code}>{item.label}</li>)}</ul>
      {(payload.otherFindings as string[]).length > 0 && <p className="text-xs text-muted-foreground">Also review: {(payload.otherFindings as string[]).join(" ")}</p>}</div>
  }
  return <p className="text-sm">{String(payload.title)} · due in {String(payload.dueInDays)} days</p>
}

function Preview({ preview }: { preview: unknown }) {
  const submission = preview as SubmissionPreview
  if (Array.isArray(submission.destinations)) {
    return <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">{submission.destinations.map(item => <div key={item.funderId}>
      <p className="font-medium">{item.name} · {item.method} · {item.destination}</p>
      {item.email && <p>To {item.email.to.join(", ")} · {item.email.subject}</p>}
      <p className="text-muted-foreground">Documents: {item.documents.map(document => document.filename).join(", ") || "none"}</p></div>)}</div>
  }
  const request = preview as RequestPreview
  return <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm"><p>To {request.recipientMasked}{request.subject ? ` · ${request.subject}` : ""}</p><p className="whitespace-pre-wrap text-muted-foreground">{request.body}</p></div>
}

export function DealAgentPanel({ dealId, onChanged }: { dealId: string; onChanged: () => void }) {
  const url = `/api/mca/deal-agent/${encodeURIComponent(dealId)}`
  const [view, setView] = React.useState<DealAgentView | { enabled: false }>()
  const [senders, setSenders] = React.useState<EmailSender[]>([])
  const [senderId, setSenderId] = React.useState("")
  const [notes, setNotes] = React.useState<Record<string, string>>({})
  const [previews, setPreviews] = React.useState<Record<string, unknown>>({})
  const [busy, setBusy] = React.useState<string>()
  const [error, setError] = React.useState<string>()

  const load = React.useCallback(async () => {
    try { setView(await requestJson<DealAgentView | { enabled: false }>(url)) }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Deal Agent could not be loaded.") }
  }, [url])
  React.useEffect(() => { void load() }, [load])
  const needsSender = Boolean(view?.enabled && view.actions.some(action => action.kind === "request_documents" && action.status === "pending"))
  React.useEffect(() => {
    if (!needsSender) return
    void requestJson<{ senders: EmailSender[] }>("/api/mca/senders").then(result => setSenders(result.senders.filter(sender => sender.purpose === "merchant" && sender.state === "verified"))).catch(() => setSenders([]))
  }, [needsSender])

  if (!view?.enabled) return null

  async function decide(action: Action, decision: "review" | "approve" | "dismiss") {
    setBusy(action.id)
    setError(undefined)
    try {
      const result = await requestJson<{ preview?: unknown }>(url, { method: "POST", body: JSON.stringify({ actionId: action.id, decision, ...(decision === "review" && action.kind === "request_documents" ? { senderId } : {}), ...(decision === "approve" && previews[action.id] ? { previewId: (previews[action.id] as { id: string }).id } : {}), ...(decision === "dismiss" && notes[action.id]?.trim() ? { note: notes[action.id].trim() } : {}) }) })
      if (decision === "review") setPreviews(current => ({ ...current, [action.id]: result.preview }))
      if (decision !== "review") onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The decision could not be saved.")
    } finally {
      setBusy(undefined)
      await load()
    }
  }

  const pending = view.actions.filter(action => action.status === "pending" || action.status === "executing")
  const decided = view.actions.filter(action => !pending.includes(action))
  return <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2"><Bot className="size-5" />Deal Agent · nothing is sent without your approval<Button variant="ghost" size="sm" className="ml-auto" disabled={Boolean(busy)} onClick={() => void load()}>Refresh</Button></CardTitle>
      <CardDescription>Proposals from the latest document analysis, completeness check and lender fit. Review shows the exact message or package; Approve hands it to the normal send path.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!pending.length && <p role="status" className="text-sm text-muted-foreground">No pending proposals.</p>}
      {pending.map(action => {
        const preview = previews[action.id]
        const reviewable = action.kind !== "schedule_follow_up"
        const disabled = busy === action.id || action.status === "executing"
        return <div key={action.id} className="space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2"><p className="font-medium">{KIND_LABELS[action.kind]}</p>{action.status === "executing" && <Badge variant="secondary">In progress</Badge>}{action.errorCode && !ERROR_NOTES[action.errorCode] && <Badge variant="destructive">{action.errorCode}</Badge>}</div>
          {action.errorCode && ERROR_NOTES[action.errorCode] && <p className="text-sm text-muted-foreground">{ERROR_NOTES[action.errorCode]}</p>}
          <Reasons action={action} />
          {action.kind === "request_documents" && <Select value={senderId} onValueChange={setSenderId}><SelectTrigger aria-label="Merchant sender"><SelectValue placeholder={senders.length ? "Verified merchant sender" : "No verified merchant sender"} /></SelectTrigger><SelectContent>{senders.map(sender => <SelectItem key={sender.id} value={sender.id}>{sender.fromAddress}</SelectItem>)}</SelectContent></Select>}
          {preview !== undefined && <Preview preview={preview} />}
          <div className="flex flex-wrap items-center gap-2">
            {reviewable && <Button variant="outline" disabled={disabled || (action.kind === "request_documents" && !senderId)} onClick={() => void decide(action, "review")}>Review</Button>}
            <Button disabled={disabled || (reviewable && preview === undefined)} onClick={() => void decide(action, "approve")}>{reviewable ? "Approve & send" : "Approve"}</Button>
            <Input className="max-w-xs" aria-label="Dismiss note" placeholder="Optional dismiss note" maxLength={500} value={notes[action.id] ?? ""} onChange={event => setNotes(current => ({ ...current, [action.id]: event.target.value }))} />
            <Button variant="ghost" disabled={disabled} onClick={() => void decide(action, "dismiss")}>Dismiss</Button>
          </div>
        </div>
      })}
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">Timeline</summary>
        <div className="mt-3 space-y-3 text-sm">
          {decided.map(action => <p key={action.id}>{KIND_LABELS[action.kind]}: {action.status === "approved" ? `Approved by ${action.decidedBy ?? "a broker"} at ${new Date(action.decidedAt!).toLocaleString()}` : action.status === "dismissed" ? `Dismissed by ${action.decidedBy ?? "a broker"}${action.decisionNote ? `: ${action.decisionNote}` : ""}` : `Failed (${action.errorCode ?? "unknown"}); check the Submissions and Closing records`}</p>)}
          {view.runs.map(run => <div key={run.id} className="space-y-1">
            <p className="font-medium">Run {new Date(run.createdAt).toLocaleString()} · {run.state}</p>
            {(run.steps as Step[]).map(step => <p key={step.step} className="flex items-start gap-2"><Badge variant={step.outcome === "failed" ? "destructive" : step.outcome === "ok" ? "default" : "secondary"}>{step.outcome}</Badge><span>{step.step}: {step.summary}</span></p>)}
          </div>)}
          {!view.runs.length && <p className="text-muted-foreground">No runs yet. The agent runs a couple of minutes after documents are uploaded.</p>}
        </div>
      </details>
    </CardContent>
  </Card>
}
