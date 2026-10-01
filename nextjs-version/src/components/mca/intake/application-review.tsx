"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowLeft, Download, Eye, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { isDocumentReady } from "@/lib/mca/documents/contracts"
import type { ApplicationReview, ApplicationSubmissionPreview } from "@/lib/mca/intake/review-contracts"
import { intakeRequest, providerNames } from "./intake-workspace"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const amount = (value: number | null) => value == null ? "Not available" : money.format(value)
const stateNames = { queued: "Queued", running: "Processing", needs_attention: "Needs attention", ready_for_review: "Ready for review", no_matches: "No matching funders", failed: "Processing failed", paused: "Paused" }
const stages = { deal: "Deal created", documents: "Documents secured", underwriting: "Statements analyzed", matches: "Funders matched" }
const panel = "min-w-0 space-y-4 rounded-xl border bg-card p-5 md:p-6"
// A preview is tied to the exact analysis, files, and matches the rep reviewed.
const revision = (review: ApplicationReview) => JSON.stringify([review.summary, review.documents, review.candidates, review.progress, review.canPrepare])

export function ApplicationReviewWorkspace({ intakeId }: { intakeId: string }) {
  const endpoint = `/api/mca/intake/${encodeURIComponent(intakeId)}/review`
  const loadSequence = useRef(0)
  const [review, setReview] = useState<ApplicationReview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<ApplicationSubmissionPreview | null>(null)
  const [previewRevision, setPreviewRevision] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [loadError, setLoadError] = useState("")
  const [now, setNow] = useState(0)
  const [results, setResults] = useState<Array<{ jobId: string; funderId: string; state: string; reason?: string }>>([])
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    try {
      const response = await fetch(endpoint, { cache: "no-store" })
      const body = await response.json().catch(() => ({}))
      if (sequence !== loadSequence.current) return
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) {
          setReview(null); setPreview(null); setSelected([]); setResults([])
        }
        throw new Error(body.error?.message ?? "Application could not be loaded.")
      }
      setReview(body as ApplicationReview)
      setLoadError("")
    } catch (e) { if (sequence === loadSequence.current) setLoadError(e instanceof Error ? e.message : "Application could not be loaded.") }
    setNow(Date.now())
  }, [endpoint])
  useEffect(() => {
    void load()
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load() }, 5000)
    window.addEventListener("focus", load)
    return () => { clearInterval(timer); window.removeEventListener("focus", load) }
  }, [load])

  async function prepare() {
    if (!review || busy) return
    setBusy("prepare"); setError(""); setPreview(null); setResults([])
    try {
      const result = await intakeRequest<ApplicationSubmissionPreview>(`${endpoint}/preview`, { method: "POST", body: JSON.stringify({ funderIds: selected }) })
      setPreview(result); setPreviewRevision(revision(review)); setNow(Date.now())
    } catch (e) { setError(e instanceof Error ? e.message : "Preview could not be prepared.") }
    finally { setBusy("") }
  }
  async function send() {
    if (!preview || !canSend || busy || Date.parse(preview.expiresAt) <= Date.now()) return
    setBusy("send"); setError("")
    try {
      const result = await intakeRequest<{ ok: true; jobs: typeof results }>(`${endpoint}/send`, { method: "POST", body: JSON.stringify({ previewId: preview.id }) })
      setResults(result.jobs); setPreview(null); setSelected([]); await load()
    } catch (e) { setError(e instanceof Error ? e.message : "Submission could not be sent. Refresh the application to check its status before retrying."); await load() }
    finally { setBusy("") }
  }
  async function retry() {
    setBusy("retry"); setError(""); setPreview(null)
    try { await intakeRequest(`/api/mca/intake/${encodeURIComponent(intakeId)}/process`, { method: "POST" }); await load() }
    catch (e) { setError(e instanceof Error ? e.message : "Processing could not be retried.") }
    finally { setBusy("") }
  }
  async function download(id: string, previewDocument = false) {
    // Open synchronously so the browser preserves the user's popup permission.
    const previewWindow = previewDocument ? window.open("about:blank", "_blank") : null
    if (previewDocument && !previewWindow) { setError("Allow pop-ups to preview this document."); return }
    if (previewWindow) previewWindow.opener = null
    setBusy(id); setError("")
    try {
      const result = await intakeRequest<{ url: string }>(`/api/mca/documents/${encodeURIComponent(id)}/download-token`, { method: "POST", body: "{}" })
      if (previewWindow) {
        const url = new URL(result.url, window.location.origin)
        url.searchParams.set("preview", "1")
        previewWindow.location.replace(url.href)
      } else window.location.assign(result.url)
    } catch (e) { previewWindow?.close(); setError(e instanceof Error ? e.message : "Document could not be opened.") }
    finally { setBusy("") }
  }
  const stale = Boolean(preview && review && (revision(review) !== previewRevision || Date.parse(preview.expiresAt) <= now))
  const validSelection = selected.length > 0 && selected.every(id => review?.candidates.some(c => c.id === id && c.eligible))
  const canPrepare = Boolean(review?.canPrepare && !review.summary.stale && validSelection && !loadError)
  const canSend = canPrepare && !!preview?.destinations.length && !stale && preview.destinations.every(d => d.errors.length === 0)
  return <main className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
    <Link href="/intake" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />Applications</Link>
    {(error || loadError) && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error || loadError}</p>}
    {!review ? <div role="status" className="py-16 text-center">{loadError ? <Button variant="outline" onClick={() => void load()}>Retry loading</Button> : <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />Loading application…</span>}</div> : <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-2xl font-semibold tracking-tight">{review.merchantName}</h1><p className="mt-2 text-sm text-muted-foreground">{providerNames[review.provider] ?? review.provider} · Received <time dateTime={review.receivedAt}>{new Date(review.receivedAt).toLocaleString()}</time></p></div>
        <div className="flex gap-2"><Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw className="size-4" />Refresh</Button>{review.dealId && <Button asChild variant="outline" size="sm"><Link href={`/deals?deal=${encodeURIComponent(review.dealId)}`}>Open deal</Link></Button>}</div>
      </header>
      <section aria-label="Processing status" className={panel}>
        <div role="status" className="space-y-2"><Badge variant={review.progress?.state === "ready_for_review" ? "default" : "secondary"}>{review.progress ? stateNames[review.progress.state] : "Awaiting processing"}</Badge><p className="text-sm text-muted-foreground">{review.progress?.message || review.message || "Review the application and documents before choosing funders."}</p></div>
        {review.progress && <ol className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">{Object.entries(stages).map(([key, label]) => {
          const stage = review.progress!.stages[key as keyof typeof stages]
          return <li key={key}><span className="font-medium">{label}</span><span className="ml-2 text-muted-foreground">{stage.state}</span>{stage.message && <p className="mt-1 text-xs text-muted-foreground">{stage.message}</p>}</li>
        })}</ol>}
        {review.canRetry && !["running", "queued"].includes(review.progress?.state ?? "") && <Button variant="outline" size="sm" disabled={!!busy || !!loadError} onClick={() => void retry()}>Retry processing</Button>}
      </section>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-6">
          <section className={panel} aria-labelledby="answers-title"><h2 id="answers-title" className="text-lg font-semibold">Application answers</h2>
            {!review.originalAnswersAvailable && <p className="text-sm text-muted-foreground">The original answers were not retained for this historical application. Available deal details are shown below.</p>}
            {review.answers.length ? <dl className="divide-y">{review.answers.map(answer => <div className="py-3 first:pt-0" key={answer.key}><dt className="text-xs font-medium text-muted-foreground">{answer.label}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm">{answer.value || "Not provided"}</dd></div>)}</dl> : <p className="text-sm text-muted-foreground">No application answers are available.</p>}
          </section>
          <section className={panel} aria-labelledby="documents-title"><h2 id="documents-title" className="text-lg font-semibold">Documents</h2>
            {review.documents.length ? <ul className="divide-y">{review.documents.map(doc => <li key={doc.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{doc.displayFilename || doc.originalFilename}</p><p className="mt-1 text-xs text-muted-foreground">{doc.category.replaceAll("_", " ")} · {doc.processingState.replaceAll("_", " ")}</p></div><div className="flex shrink-0 gap-2"><Button variant="outline" size="sm" disabled={!!busy || !!loadError || !isDocumentReady(doc.processingState)} onClick={() => void download(doc.id, true)} aria-label={`Preview ${doc.displayFilename || doc.originalFilename} in a new tab`}><Eye className="size-4" /><span className="sr-only sm:not-sr-only">Preview</span></Button><Button variant="outline" size="sm" disabled={!!busy || !!loadError || !isDocumentReady(doc.processingState)} onClick={() => void download(doc.id)} aria-label={`Download ${doc.displayFilename || doc.originalFilename}`}><Download className="size-4" /><span className="sr-only sm:not-sr-only">Download</span></Button></div></li>)}</ul> : <p className="text-sm text-muted-foreground">No documents received yet.</p>}
          </section>
        </div>
        <div className="min-w-0 space-y-6">
          <section className={panel} aria-labelledby="summary-title"><div><h2 id="summary-title" className="text-lg font-semibold">AI analysis summary</h2><p className="mt-1 text-xs text-muted-foreground">Check these facts against the original answers and statements.</p></div>
            <dl className="grid grid-cols-2 gap-5 text-sm">{[["Applicant-reported monthly revenue", amount(review.summary.reportedMonthlyRevenue)], ["Statement-derived monthly revenue", amount(review.summary.statementMonthlyRevenue)], ["Industry", review.summary.industry || "Not available"], ["Requested amount", amount(review.summary.requestedAmount)]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words font-medium">{value}</dd></div>)}</dl>
            {review.summary.analyzedAt && <p className="text-xs text-muted-foreground">Analyzed {new Date(review.summary.analyzedAt).toLocaleString()}</p>}
            {review.summary.stale && <p className="rounded-md bg-muted p-3 text-sm">Analysis is out of date. Reprocess the application before preparing submissions.</p>}
            {review.summary.warnings.length > 0 && <div><h3 className="text-sm font-medium">Warnings</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{review.summary.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
            {review.summary.missing.length > 0 && <div><h3 className="text-sm font-medium">Missing information</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{review.summary.missing.map((missing, i) => <li key={i}>{missing}</li>)}</ul></div>}
          </section>
          <section className={panel} aria-labelledby="funders-title"><div><h2 id="funders-title" className="text-lg font-semibold">Recommended funders</h2><p className="mt-1 text-sm text-muted-foreground">Choose recipients to prepare a preview. Nothing is sent until you approve it.</p></div>
            {review.candidates.length ? <fieldset disabled={!!busy || !!loadError || !review.canPrepare || review.summary.stale} className="space-y-3"><legend className="sr-only">Select funders</legend>{[...review.candidates].sort((a, b) => a.rank - b.rank).map(funder => <label key={funder.id} className="flex items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:disabled]:opacity-60"><input type="checkbox" className="mt-1 size-4 accent-primary" checked={selected.includes(funder.id)} disabled={!funder.eligible} onChange={event => { setSelected(ids => event.target.checked ? [...ids, funder.id] : ids.filter(id => id !== funder.id)); setPreview(null) }} /><span className="min-w-0"><span className="block text-sm font-medium">{funder.rank}. {funder.name}</span><span className="mt-1 block text-xs text-muted-foreground">Grade {funder.grade} · Score {funder.score}{!funder.eligible && " · Not eligible"}</span>{funder.reasons.map((reason, i) => <span key={i} className="mt-1 block text-xs text-muted-foreground">{reason}</span>)}</span></label>)}</fieldset> : <p className="rounded-lg bg-muted p-4 text-sm">{review.progress?.state === "no_matches" ? "No funders currently match this application. Review the missing information and funder criteria in the deal." : "Funder recommendations will appear after processing completes."}</p>}
            {!review.canPrepare && <p className="text-xs text-muted-foreground">Preparing submissions requires a completed analysis and permission to submit this deal.</p>}
            <Button disabled={!!busy || !canPrepare} onClick={() => void prepare()}>{busy === "prepare" && <Loader2 className="size-4 animate-spin" />}Prepare {selected.length || ""} submission{selected.length === 1 ? "" : "s"}</Button>
          </section>
        </div>
      </div>
      {preview && <section className={panel} aria-labelledby="preview-title"><div><h2 id="preview-title" className="text-lg font-semibold">Submission preview</h2><p className="mt-1 text-sm text-muted-foreground">Review every destination and attachment. This preview has not sent anything.</p></div>
        {stale && <p role="alert" className="text-sm text-destructive">This preview expired or the application changed. Prepare a new preview before sending.</p>}
        {preview.destinations.map(destination => <article key={destination.funderId} className="space-y-3 rounded-lg border p-4"><h3 className="font-medium">{destination.name}</h3><p className="break-words text-sm">Method: {destination.method} · Destination: {destination.destination || "Not configured"}</p>
          {destination.providerReadiness && <p className="text-sm text-muted-foreground">{destination.providerReadiness}</p>}
          {destination.email && <><dl className="space-y-2 text-sm">{[["From", destination.email.from], ["To", destination.email.to.join(", ")], ["CC", destination.email.cc.join(", ") || "None"], ["Reply to", destination.email.replyTo], ["Subject", destination.email.subject]].map(([label, value]) => <div key={label} className="break-words"><dt className="inline font-medium">{label}: </dt><dd className="inline">{value}</dd></div>)}</dl><div><h4 className="text-sm font-medium">Message</h4><pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-sans text-sm">{destination.email.body}</pre></div></>}
          <div><h4 className="text-sm font-medium">Attachments</h4>{destination.documents.length ? <ul className="mt-1 list-disc pl-5 text-sm">{destination.documents.map(doc => <li className="break-words" key={doc.id}>{doc.filename}</li>)}</ul> : <p className="text-sm text-muted-foreground">No attachments</p>}</div>
          {destination.method.includes("portal") && <p className="text-sm text-muted-foreground">A manual portal submission must be completed from the deal after approval.</p>}
          {destination.errors.length > 0 && <ul role="alert" className="list-disc pl-5 text-sm text-destructive">{destination.errors.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
        </article>)}
        <p className="text-xs text-muted-foreground">Preview expires {new Date(preview.expiresAt).toLocaleString()}.</p>
        <Button disabled={!!busy || !canSend} onClick={() => void send()}>{busy === "send" && <Loader2 className="size-4 animate-spin" />}Send approved submissions</Button>
      </section>}
      {(results.length > 0 || review.jobs.length > 0) && <section className={panel} aria-labelledby="results-title"><h2 id="results-title" className="text-lg font-semibold">Submission status</h2><ul aria-live="polite" className="divide-y">{[...review.jobs, ...results.filter(result => !review.jobs.some(job => job.jobId === result.jobId)).map(result => ({ ...result, displayFunderName: review.candidates.find(funder => funder.id === result.funderId)?.name ?? "Funder" }))].map(job => <li className="space-y-1 py-3 text-sm" key={job.jobId}><p className="font-medium">{job.displayFunderName} · {job.state.replaceAll("_", " ")}</p>{job.reason && <p className="text-muted-foreground">{job.reason}</p>}{(job.state === "pending_portal" || job.state.includes("manual")) && review.dealId && <Link className="inline-block underline" href={`/deals?deal=${encodeURIComponent(review.dealId)}`}>Complete portal submission in deal</Link>}</li>)}</ul></section>}
    </>}
  </main>
}
