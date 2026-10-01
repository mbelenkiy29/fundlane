"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Inbox, Loader2, Mail } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RequestError, requestJson } from "@/lib/mca/client"

type ReplyState = "pending_review" | "matched" | "ignored" | "processed"

type ReplyEvidence = {
  method: "message_id" | "thread" | "domain" | "unrecognized" | "ambiguous" | "manual"
  flagsUnchanged: true
  fromDomain?: string
  funderNames?: string[]
  candidateJobIds?: string[]
  notes: string[]
  subjectHits?: string[]
}

type FunderReply = {
  id: string
  senderId: string
  providerMessageId: string
  threadId?: string
  fromAddress: string
  subject?: string
  bodyPreview?: string
  matchedDealId?: string
  matchedJobId?: string
  evidence: ReplyEvidence
  state: ReplyState
  replayed: boolean
  createdAt: string
}

type SenderHealth = {
  senderId: string
  fromAddress: string
  provider: string
  optedIn: boolean
  lastRunAt?: string
  lastError?: string | null
  health: "idle" | "ready" | "error" | "unconfigured"
}

type CandidateJob = {
  jobId: string
  funderId: string
  displayFunderName: string
  state: string
}

type QueuePayload = {
  dealId?: string
  intervalMs: number
  mailbox: { mode: "fixture" | "unconfigured" | "live"; liveOAuth: boolean }
  senders: SenderHealth[]
  replies: FunderReply[]
  candidateJobs: CandidateJob[]
  canReview: boolean
  canManage: boolean
}

type Proposal = {
  proposalKey: string
  state: "empty" | "preview" | "success" | "unmatched"
  classification: "approval" | "decline" | "pending" | "unparseable" | "unrelated"
  requiresReview: boolean
  extraction: {
    terms: {
      amount: { value: number | null }
      rate: { value: number | null }
      term: { value: number | null }
      paymentAmount?: { value: number | null }
      frequency: { value: string | null }
      declineReason?: { value: string | null }
    }
    stipulations: Array<{ text: string }>
    warnings: string[]
    summary: string
  }
}

function ReplyProposal({ reply, onSaved }: { reply: FunderReply; onSaved: () => Promise<void> }) {
  const [proposal, setProposal] = React.useState<Proposal>()
  const [classification, setClassification] = React.useState<Proposal["classification"]>("unparseable")
  const [amount, setAmount] = React.useState("")
  const [rate, setRate] = React.useState("")
  const [term, setTerm] = React.useState("")
  const [paymentAmount, setPaymentAmount] = React.useState("")
  const [frequency, setFrequency] = React.useState("")
  const [declineReason, setDeclineReason] = React.useState("")
  const [stipulations, setStipulations] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [saved, setSaved] = React.useState(false)

  const showProposal = React.useCallback((result: Proposal) => {
    setProposal(result)
    setClassification(result.classification)
    setAmount(String(result.extraction.terms.amount.value ?? ""))
    setRate(String(result.extraction.terms.rate.value ?? ""))
    setTerm(String(result.extraction.terms.term.value ?? ""))
    setPaymentAmount(String(result.extraction.terms.paymentAmount?.value ?? ""))
    setFrequency(result.extraction.terms.frequency.value ?? "")
    setDeclineReason(result.extraction.terms.declineReason?.value ?? "")
    setStipulations(result.extraction.stipulations.map((item) => item.text).join("\n"))
    setSaved(false)
  }, [])

  const preview = React.useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await requestJson<Proposal>("/api/mca/submissions/extract/preview", { method: "POST", body: JSON.stringify({ replyId: reply.id }) })
      showProposal(result)
    } catch (caught) { setError(errorMessage(caught, "Reply could not be parsed.")) }
    finally { setBusy(false) }
  }, [reply.id, showProposal])

  React.useEffect(() => {
    if (!reply.matchedJobId || reply.state === "processed") return
    let active = true
    void requestJson<Proposal>(`/api/mca/submissions/extract/${encodeURIComponent(reply.id)}`)
      .then(async (current) => current.state === "empty"
        ? requestJson<Proposal>("/api/mca/submissions/extract/preview", { method: "POST", body: JSON.stringify({ replyId: reply.id }) })
        : current)
      .then((result) => { if (active) showProposal(result) })
      .catch((caught) => { if (active) setError(errorMessage(caught, "Reply could not be parsed.")) })
    return () => { active = false }
  }, [reply.id, reply.matchedJobId, reply.state, showProposal])

  async function confirm() {
    if (!proposal) return
    setBusy(true)
    setError(undefined)
    const original = proposal.extraction.terms
    const changed = classification !== proposal.classification
      || amount !== String(original.amount.value ?? "") || rate !== String(original.rate.value ?? "")
      || term !== String(original.term.value ?? "") || paymentAmount !== String(original.paymentAmount?.value ?? "")
      || frequency !== (original.frequency.value ?? "") || declineReason !== (original.declineReason?.value ?? "")
      || stipulations !== proposal.extraction.stipulations.map((item) => item.text).join("\n")
    const numeric = (value: string) => {
      if (!value.trim()) return null
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Enter positive numbers for offer terms, or leave them blank.")
      return parsed
    }
    try {
      await requestJson(changed ? `/api/mca/submissions/extract/${encodeURIComponent(reply.id)}` : "/api/mca/submissions/extract", {
        method: changed ? "PATCH" : "POST",
        body: JSON.stringify(changed ? {
          classification, amount: numeric(amount), rate: numeric(rate), term: numeric(term),
          paymentAmount: numeric(paymentAmount), frequency, declineReason,
          stipulations: stipulations.split("\n").map((text) => text.trim()).filter(Boolean).map((text) => ({ text })),
          expectedProposalKey: proposal.proposalKey,
        } : { replyId: reply.id, confirm: true, expectedClassification: proposal.classification, expectedProposalKey: proposal.proposalKey }),
      })
      setSaved(true)
      await onSaved()
    } catch (caught) { setError(errorMessage(caught, "Outcome could not be confirmed.")) }
    finally { setBusy(false) }
  }

  const offerFields = [
    { id: "amount", label: "Amount", value: amount, onChange: setAmount },
    { id: "rate", label: "Factor/rate", value: rate, onChange: setRate },
    { id: "term", label: "Term (months)", value: term, onChange: setTerm },
    { id: "payment-amount", label: "Payment amount", value: paymentAmount, onChange: setPaymentAmount },
    { id: "frequency", label: "Payment frequency", value: frequency, onChange: setFrequency },
  ]

  return <div className="space-y-3 border-t pt-3">
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void preview()}>{busy ? "Working…" : "Propose outcome"}</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {saved && <p role="status" className="text-sm text-emerald-700">Outcome confirmed and saved.</p>}
    {proposal && !saved && <div className="space-y-3 rounded-md bg-muted/40 p-3">
      <p className="text-sm font-medium">Review proposal against the original reply before saving</p>
      <p className="text-xs text-muted-foreground">{proposal.extraction.summary}</p>
      {proposal.extraction.warnings.map((warning, index) => <p key={index} className="text-xs text-amber-700">{warning}</p>)}
      <div className="space-y-1"><Label>Outcome</Label><Select value={classification} onValueChange={(value) => setClassification(value as Proposal["classification"])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
        <SelectItem value="approval">Offer</SelectItem><SelectItem value="decline">Decline</SelectItem><SelectItem value="pending">Stip request</SelectItem><SelectItem value="unparseable">Manual review</SelectItem><SelectItem value="unrelated">Unrelated</SelectItem>
      </SelectContent></Select></div>
      <div className="grid gap-2 sm:grid-cols-3">
        {offerFields.map((field) => <div key={field.id} className="space-y-1"><Label htmlFor={`${reply.id}-${field.id}`}>{field.label}</Label><Input id={`${reply.id}-${field.id}`} value={field.value} onChange={(event) => field.onChange(event.target.value)} /></div>)}
      </div>
      <div className="space-y-1"><Label>Decline reason</Label><Input value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} /></div>
      <div className="space-y-1"><Label>Stip requests, one per line</Label><Textarea value={stipulations} onChange={(event) => setStipulations(event.target.value)} /></div>
      {proposal.requiresReview && <p className="text-xs text-amber-700">This reply needs manual review. Link a submission and correct the outcome before confirming.</p>}
      <Button size="sm" disabled={busy || !reply.matchedJobId || classification === "unparseable" || classification === "unrelated"} onClick={() => void confirm()}>Confirm outcome</Button>
    </div>}
  </div>
}

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof RequestError) {
    const fields = caught.fieldErrors ? Object.values(caught.fieldErrors).flat().join(" ") : ""
    if (fields) return fields
    return caught.message
  }
  return caught instanceof Error ? caught.message : fallback
}

function stateVariant(state: ReplyState): "default" | "secondary" | "destructive" | "outline" {
  if (state === "matched" || state === "processed") return "default"
  if (state === "pending_review") return "secondary"
  if (state === "ignored") return "outline"
  return "outline"
}

function stateLabel(state: ReplyState): string {
  return state.split("_").join(" ")
}

function minutes(intervalMs: number): number {
  return Math.max(1, Math.round(intervalMs / 60_000))
}

export function ReplyQueue({ dealId }: { dealId: string }) {
  const [payload, setPayload] = React.useState<QueuePayload>()
  const [jobByReply, setJobByReply] = React.useState<Record<string, string>>({})
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const [optInId, setOptInId] = React.useState<string>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<QueuePayload>(`/api/mca/submissions/replies?dealId=${encodeURIComponent(dealId)}`)
      setPayload(next)
      const preferred = next.senders.find((item) => item.optedIn)?.senderId ?? next.senders[0]?.senderId
      setOptInId((current) => current ?? preferred)
    } catch (caught) {
      setError(errorMessage(caught, "Funder replies could not be loaded."))
    } finally {
      setLoading(false)
    }
  }, [dealId])

  React.useEffect(() => { void load() }, [load])

  async function runIngest(enabled?: boolean) {
    if (enabled !== undefined && !optInId) {
      setError("Choose a submission sender to opt in.")
      return
    }
    setBusy("run")
    setError(undefined)
    setMessage(undefined)
    try {
      const result = await requestJson<{ createdCount: number; replayedCount: number; intervalMs: number }>(
        "/api/mca/submissions/replies/run",
        {
          method: "POST",
          body: JSON.stringify({
            senderId: optInId,
            ...(enabled === undefined ? {} : { enabled }),
          }),
        },
      )
      setMessage(enabled === false
        ? "Mailbox ingestion opted out for this sender."
        : `Ingest finished. ${result.createdCount} new, ${result.replayedCount} replayed. Fallback interval is ${minutes(result.intervalMs)} minutes (worker POST, not a live cron).`)
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "Mailbox ingest could not run."))
    } finally {
      setBusy(undefined)
    }
  }

  async function review(reply: FunderReply, state: "matched" | "ignored") {
    if (state === "matched" && !jobByReply[reply.id] && !reply.matchedJobId && payload?.candidateJobs.length) {
      setError("Choose a submission job to link this reply.")
      return
    }
    setBusy(`${state}:${reply.id}`)
    setError(undefined)
    setMessage(undefined)
    try {
      const next = await requestJson<FunderReply>(`/api/mca/submissions/replies/${encodeURIComponent(reply.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          state,
          matchedJobId: state === "matched" ? jobByReply[reply.id] || reply.matchedJobId : undefined,
          matchedDealId: dealId,
        }),
      })
      setMessage(next.state === "matched"
        ? "Reply linked to this deal. Replay keeps the same record id."
        : "Reply ignored. The mailbox flags were not changed.")
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "The reply could not be updated."))
    } finally {
      setBusy(undefined)
    }
  }

  const replies = payload?.replies ?? []
  const senders = payload?.senders ?? []
  const empty = !loading && !error && replies.length === 0
  const interval = payload ? minutes(payload.intervalMs) : 15

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Inbox className="size-5" />Funder replies</CardTitle>
          <CardDescription>
            Read-only mailbox ingest correlates Message-ID/thread before funder.domains. Ambiguous mail stays in review. Fallback polling is {interval} minutes via worker POST, not a live cron.
          </CardDescription>
        </div>
        <Button onClick={() => void load()} disabled={loading || Boolean(busy)} variant="outline" aria-label="Refresh funder replies">
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading funder replies…</p>}
        {error && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</p>}
        {message && <p role="status" className="flex items-start gap-2 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{message}</p>}

        {payload && (
          <div className="space-y-3 rounded-lg border p-3">
            <p className="text-sm font-medium">Mailbox</p>
            <p className="text-sm text-muted-foreground">
              {payload.mailbox.liveOAuth
                ? "Live mailbox ingest is enabled. Check sender health below before running it."
                : payload.mailbox.mode === "fixture"
                  ? "Fixture mailbox injected. Live Google/Microsoft read OAuth remains a gate."
                  : "Live mailbox OAuth is not configured. Opt in a sender, then run the worker when a mailbox is available."}
            </p>
            {payload.canManage && senders.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                <div className="space-y-1.5">
                  <Label htmlFor="reply-sender">Submission sender</Label>
                  <Select value={optInId ?? ""} onValueChange={setOptInId} disabled={Boolean(busy)}>
                    <SelectTrigger id="reply-sender" aria-label="Submission sender">
                      <SelectValue placeholder="Choose a sender" />
                    </SelectTrigger>
                    <SelectContent>
                      {senders.map((sender) => (
                        <SelectItem key={sender.senderId} value={sender.senderId}>
                          {sender.fromAddress} ({sender.optedIn ? sender.health : "not opted in"})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button variant="outline" disabled={Boolean(busy)} onClick={() => void runIngest(true)}>
                  {busy === "run" ? <Loader2 className="size-4 animate-spin" /> : null}
                  Opt in
                </Button>
                <Button disabled={Boolean(busy)} onClick={() => void runIngest()}>
                  {busy === "run" ? <Loader2 className="size-4 animate-spin" /> : null}
                  Run ingest
                </Button>
              </div>
            )}
            {senders.filter((item) => item.optedIn).map((sender) => (
              <p key={sender.senderId} className="text-xs text-muted-foreground">
                {sender.fromAddress}: {sender.health}
                {sender.lastRunAt ? ` · last run ${sender.lastRunAt}` : ""}
                {sender.lastError ? ` · ${sender.lastError}` : ""}
              </p>
            ))}
          </div>
        )}

        {empty && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No funder replies to review for this deal. Opt in a sender and run ingest after a submission is sent.
          </div>
        )}

        {replies.map((reply) => (
          <div key={reply.id} className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{reply.subject || "(no subject)"}</p>
                <p className="text-xs text-muted-foreground">{reply.fromAddress}</p>
              </div>
              <Badge variant={stateVariant(reply.state)}>{stateLabel(reply.state)}</Badge>
            </div>
            {reply.bodyPreview && <p className="text-sm text-muted-foreground">{reply.bodyPreview}</p>}
            <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              <li>Match: {reply.evidence.method}{reply.evidence.fromDomain ? ` · ${reply.evidence.fromDomain}` : ""}</li>
              {reply.evidence.notes.map((note) => <li key={note}>{note}</li>)}
              {reply.replayed && <li>Replay reused this record id.</li>}
            </ul>
            {payload?.canReview && reply.state === "pending_review" && (
              <div className="flex flex-wrap items-end gap-2">
                {payload.candidateJobs.length > 0 && (
                  <div className="min-w-48 space-y-1.5">
                    <Label htmlFor={`reply-job-${reply.id}`}>Link to job</Label>
                    <Select
                      value={jobByReply[reply.id] ?? ""}
                      onValueChange={(value) => setJobByReply((current) => ({ ...current, [reply.id]: value }))}
                      disabled={Boolean(busy)}
                    >
                      <SelectTrigger id={`reply-job-${reply.id}`} aria-label="Link to job">
                        <SelectValue placeholder="Choose a job" />
                      </SelectTrigger>
                      <SelectContent>
                        {payload.candidateJobs.map((job) => (
                          <SelectItem key={job.jobId} value={job.jobId}>
                            {job.displayFunderName} ({job.state})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <Button size="sm" disabled={Boolean(busy)} onClick={() => void review(reply, "matched")}>
                  {busy === `matched:${reply.id}` ? <Loader2 className="size-4 animate-spin" /> : null}
                  Link
                </Button>
                <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void review(reply, "ignored")}>
                  Ignore
                </Button>
              </div>
            )}
            {payload?.canReview && reply.state !== "ignored" && <ReplyProposal reply={reply} onSaved={load} />}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
