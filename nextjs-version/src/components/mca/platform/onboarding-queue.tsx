"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table"
import { PLATFORM_REFRESH_EVENT } from "@/lib/mca/platform-refresh"
import { enrollmentQueueStates, type EnrollmentOperationsPage } from "@/lib/mca/onboarding/operator-contracts"
import { PlatformSection, PlatformStatus } from "./presentation"
import { OnboardingRecovery } from "./onboarding-recovery"

const words = (value: string) => value.replaceAll("_", " ")
const age = (createdAt: string, snapshotAt: string) => `${Math.max(0, Math.floor((Date.parse(snapshotAt) - Date.parse(createdAt)) / 60_000))} min`

export function EnrollmentQueueResults({ page, loading = false, error, onInspect, actionPending = false }: { page?: EnrollmentOperationsPage; loading?: boolean; error?: string; onInspect?: (id: string) => void; actionPending?: boolean }) {
  return <div className="min-w-0 space-y-3" aria-busy={loading}>
    {loading && <p role="status">Loading enrollments…</p>}
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error} {page ? "Stale snapshot: these results could not be refreshed." : "Try refreshing the queue."}</p>}
    {page && <>
      <div className="flex flex-wrap gap-2" aria-label="Enrollment runtime flags">
        <PlatformStatus value={page.runtime.enabled ? "Runtime enabled" : "Runtime disabled"} />
        <PlatformStatus value={page.runtime.creationEnabled ? "Creation enabled" : "Creation disabled"} />
        <PlatformStatus value={page.runtime.emailEnabled ? "Mail enabled" : "Mail disabled"} />
      </div>
      <p className="text-sm text-muted-foreground">Database snapshot <time dateTime={page.snapshotAt}>{page.snapshotAt}</time>. Due repairs without a live lease are marked stalled after 15 minutes. Flags describe this application process; scheduler ownership must be verified separately.</p>
      <p className="text-sm text-muted-foreground">Accepted is not proof of receipt. Mail states belong to each current message generation; unknown acceptance requires evidence before retry.</p>
      {!page.items.length ? <p className="py-6 text-sm text-muted-foreground">No matching enrollments.</p> :
        <Table aria-label="Trial enrollment operations"><TableHeader><TableRow>
          <TableHead>Enrollment / age</TableHead><TableHead>Checkout / claim</TableHead><TableHead>Billing / company</TableHead><TableHead>Repair / compensation</TableHead><TableHead>Business information mail</TableHead><TableHead>Getting started mail</TableHead>
        </TableRow></TableHeader><TableBody>{page.items.map(row => <TableRow key={row.enrollmentId}>
          <TableCell><code className="select-all text-xs">{row.enrollmentId}</code><div>{age(row.createdAt, page.snapshotAt)} old</div><div className="text-xs text-muted-foreground">Created {row.createdAt} · revision {row.revision}</div>{onInspect && <Button variant="outline" size="sm" disabled={loading || Boolean(error) || actionPending} aria-label={`Inspect enrollment ${row.enrollmentId}`} onClick={() => onInspect(row.enrollmentId)}>Inspect</Button>}</TableCell>
          <TableCell><PlatformStatus value={row.checkoutState} /> <PlatformStatus value={row.claimState} /><div>Finalization: {words(row.finalizationState)}</div></TableCell>
          <TableCell><PlatformStatus value={row.billingState} /><div>Trial ends: {row.trialEndsAt ?? "Not activated"}</div><div>Verified: {row.verifiedAt ?? "No verified read"}</div>{row.workspaceId && <Link className="underline" href={`/platform/companies/${encodeURIComponent(row.workspaceId)}`}>Company {row.workspaceId}</Link>}</TableCell>
          <TableCell><PlatformStatus value={row.repairState} /> <PlatformStatus value={row.recoveryState} /><div>Next repair: {row.nextReconcileAt}</div>{row.leaseUntil && <div>Lease until: {row.leaseUntil}</div>}{row.hasRepairError && <div className="text-destructive">Repair error recorded</div>}</TableCell>
          {(["business_information_requested", "getting_started"] as const).map(purpose => {
            const mail = row.emails.find(email => email.purpose === purpose)
            return <TableCell key={purpose}>{mail ? <><PlatformStatus value={mail.state} /><div>{mail.attempts} attempts</div>{["queued", "retry"].includes(mail.state) && <div>Next attempt: {mail.nextAttemptAt}</div>}{mail.hasError && <div className="text-destructive">Mail error recorded</div>}</> : "No current intent"}</TableCell>
          })}
        </TableRow>)}</TableBody></Table>}
    </>}
  </div>
}

class QueueReadError extends Error {
  constructor(readonly denied: boolean) { super(denied ? "Access denied. Sign in with an authorized owner session." : "Could not load enrollments.") }
}

export function OnboardingQueue() {
  const [query, setQuery] = useState({ enrollmentId: "", state: "", cursor: "" })
  const [refresh, setRefresh] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState(false)
  const actionBusy = useRef(false)
  const busy = useRef(false)
  const [result, setResult] = useState<{ url: string; key: string; page?: EnrollmentOperationsPage; error?: string }>({ url: "", key: "" })
  useEffect(() => {
    const refreshQueue = () => { if (!busy.current && !actionBusy.current) setRefresh(value => value + 1) }
    window.addEventListener(PLATFORM_REFRESH_EVENT, refreshQueue)
    return () => window.removeEventListener(PLATFORM_REFRESH_EVENT, refreshQueue)
  }, [])
  const params = new URLSearchParams({ limit: "50" })
  for (const [name, value] of Object.entries(query)) if (value) params.set(name, value)
  const url = `/api/platform/onboarding?${params}`, key = `${url}:${refresh}`
  useEffect(() => {
    busy.current = true
    const controller = new AbortController()
    void fetch(url, { cache: "no-store", credentials: "same-origin", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new QueueReadError(response.status === 401 || response.status === 403)
      const page: EnrollmentOperationsPage = await response.json()
      if (!controller.signal.aborted) setResult({ url, key, page })
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        if (error instanceof QueueReadError && error.denied) setSelectedId(null)
        setResult(previous => ({ url, key, error: error instanceof QueueReadError ? error.message : "Could not load enrollments.", ...(previous.url === url && !(error instanceof QueueReadError && error.denied) ? { page: previous.page } : {}) }))
      }
    }).finally(() => { if (!controller.signal.aborted) busy.current = false })
    return () => { controller.abort(); busy.current = false }
  }, [url, key])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (actionPending) return
    const form = new FormData(event.currentTarget)
    setQuery({ enrollmentId: String(form.get("enrollmentId") ?? "").trim(), state: String(form.get("state") ?? ""), cursor: "" })
    setSelectedId(null)
    setRefresh(value => value + 1)
  }
  const loading = result.key !== key, visible = result.url === url ? result : undefined
  return <PlatformSection title="Enrollment queue" description="Read-only diagnostics remain available during rollback. Filters apply before pagination. Recovery changes require a separately verified action.">
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/20 p-3">
      <Label className="grid gap-2">Enrollment ID<Input name="enrollmentId" maxLength={36} defaultValue={query.enrollmentId} /></Label>
      <div className="grid gap-2"><Label htmlFor="enrollment-queue-state">State</Label><select id="enrollment-queue-state" name="state" defaultValue={query.state} className="h-9 rounded-md border bg-background px-3"><option value="">All states</option>{enrollmentQueueStates.map(state => <option key={state} value={state}>{words(state)}</option>)}</select></div>
      <Button type="submit" disabled={actionPending}>Apply filters</Button><Button type="button" variant="outline" disabled={loading || actionPending} onClick={() => { if (!busy.current) setRefresh(value => value + 1) }}>Refresh queue</Button>
    </form>
    <EnrollmentQueueResults page={visible?.page} error={visible?.error} loading={loading} onInspect={setSelectedId} actionPending={actionPending} />
    <nav aria-label="Enrollment queue pages" className="flex flex-wrap gap-3">
      {query.cursor && <Button variant="outline" disabled={loading || actionPending} onClick={() => { setSelectedId(null); setQuery(previous => ({ ...previous, cursor: "" })) }}>First page</Button>}
      {visible?.page?.nextCursor && <Button variant="outline" disabled={loading || actionPending} onClick={() => { setSelectedId(null); setQuery(previous => ({ ...previous, cursor: visible.page!.nextCursor! })) }}>Next 50</Button>}
    </nav>
    {selectedId && <OnboardingRecovery key={selectedId} enrollmentId={selectedId} queueSafe={!loading && Boolean(visible?.page) && !visible?.error} onUpdated={() => setRefresh(value => value + 1)} onBusyChange={value => { actionBusy.current = value; setActionPending(value) }} />}
  </PlatformSection>
}
