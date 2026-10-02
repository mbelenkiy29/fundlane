"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RequestError, requestJson } from "@/lib/mca/client"
import { PLATFORM_REFRESH_EVENT } from "@/lib/mca/platform-refresh"
import type { EnrollmentOperatorAction, EnrollmentOperatorDetail, EnrollmentOperatorEmail, EnrollmentOperatorTarget } from "@/lib/mca/onboarding/operator-contracts"
import { PlatformStatus } from "./presentation"

type Outcome = "accepted" | "delivered" | "failed" | "suppressed"
type Draft = { action: EnrollmentOperatorAction; revision: number; reason: string; reference: string; correctedEmail: string; outcome: Outcome; messageId: string; email?: EnrollmentOperatorEmail; target?: EnrollmentOperatorTarget }
const names: Record<EnrollmentOperatorAction, string> = { verify_target: "Verify target", approve_identity: "Approve identity", record_email_evidence: "Record mail evidence", reissue_emails: "Reissue service emails" }
const words = (value: string) => value.replaceAll("_", " ")
const messageIds = (email: EnrollmentOperatorEmail) => [...new Set([email.providerMessageId, ...email.receipts.map(receipt => receipt.providerMessageId)].filter((value): value is string => Boolean(value)))]
const positiveHistory = (email: EnrollmentOperatorEmail) => ["accepted", "delivered"].includes(email.state) || email.receipts.some(receipt => ["accepted", "delivered"].includes(receipt.state)) || messageIds(email).length > 0
// Elapsed age changes on every read; transport/state/receipt changes require a new inspected draft.
const mailBinding = (email: EnrollmentOperatorEmail) => JSON.stringify({ ...email, ageSeconds: 0 })
const opaqueReference = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/
const matchesDraft = (draft: Draft, data: EnrollmentOperatorDetail) => {
  if (draft.revision !== data.revision || !data.availableActions.includes(draft.action)) return false
  if (draft.email) {
    const email = data.emails.find(email => email.id === draft.email!.id)
    if (!email?.canRecordEvidence || mailBinding(draft.email) !== mailBinding(email)) return false
  }
  return !draft.target || JSON.stringify(data.targetVerification[0]) === JSON.stringify(draft.target)
}

export function OnboardingRecovery({ enrollmentId, onUpdated, onBusyChange, queueSafe }: { enrollmentId: string; onUpdated: () => void; onBusyChange: (busy: boolean) => void; queueSafe: boolean }) {
  const [observation, setObservation] = useState<{ data?: EnrollmentOperatorDetail; error?: string }>({})
  const current = useRef(observation)
  const [loading, setLoading] = useState(true)
  const reading = useRef<Promise<void> | null>(null)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const mutating = useRef(false)
  const [pending, setPending] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [code, setCode] = useState("")
  const [steppedUp, setSteppedUp] = useState(false)
  const [notice, setNotice] = useState("")
  const [actionError, setActionError] = useState("")
  const url = `/api/platform/onboarding/${encodeURIComponent(enrollmentId)}`
  const read = useCallback(() => {
    if (reading.current) return reading.current
    const abort = new AbortController()
    controller.current = abort
    setLoading(true)
    const operation = requestJson<EnrollmentOperatorDetail>(url, { credentials: "same-origin", signal: abort.signal }).then(data => {
      if (!mounted.current || abort.signal.aborted) return
      current.current = { data }
      setObservation(current.current)
    }).catch((error: unknown) => {
      if (!mounted.current || abort.signal.aborted) return
      const denied = error instanceof RequestError && [401, 403].includes(error.status)
      current.current = { ...(denied ? {} : { data: current.current.data }), error: denied ? "Access denied. Sign in with an authorized owner session." : "Could not refresh detail. Stale diagnostics are shown; actions are disabled." }
      setObservation(current.current)
      if (denied) { setDraft(null); setCode(""); setSteppedUp(false); setNotice(""); setActionError("") }
    }).finally(() => {
      if (!abort.signal.aborted) { reading.current = null; if (mounted.current) setLoading(false) }
    })
    reading.current = operation
    return operation
  }, [url])
  useEffect(() => {
    mounted.current = true
    void read()
    const refresh = () => { if (!mutating.current) void read() }
    window.addEventListener(PLATFORM_REFRESH_EVENT, refresh)
    return () => { mounted.current = false; controller.current?.abort(); window.removeEventListener(PLATFORM_REFRESH_EVENT, refresh) }
  }, [read])
  const data = observation.data
  const safe = queueSafe && !loading && !observation.error && Boolean(data?.runtime.runtimeEnabled)
  const staleDraft = Boolean(draft && data && !matchesDraft(draft, data))
  const begin = (action: EnrollmentOperatorAction, email?: EnrollmentOperatorEmail, target?: EnrollmentOperatorTarget) => {
    if (!safe || !data || mutating.current) return
    setDraft({ action, revision: data.revision, reason: "", reference: "", correctedEmail: "", outcome: "accepted", messageId: email ? messageIds(email)[0] ?? "" : "", email, target })
    setSteppedUp(false); setCode(""); setNotice(""); setActionError("")
  }
  const update = (values: Partial<Draft>) => { setDraft(previous => previous ? { ...previous, ...values } : null); setSteppedUp(false); setActionError("") }
  const lock = () => { mutating.current = true; setPending(true); onBusyChange(true) }
  const unlock = () => { mutating.current = false; if (mounted.current) { setPending(false); onBusyChange(false) } }
  const verifyCode = async () => {
    if (!safe || staleDraft || !draft || !code.trim() || mutating.current) return
    lock(); setActionError("")
    try {
      await requestJson("/api/platform/step-up", { method: "POST", credentials: "same-origin", body: JSON.stringify({ code: code.trim() }) })
      if (mounted.current) { setSteppedUp(true); setCode("") }
    } catch (error: unknown) {
      if (mounted.current) { setSteppedUp(false); setActionError(error instanceof RequestError ? `Step-up failed (${error.code}).` : "Step-up could not be completed.") }
      if (error instanceof RequestError && [401, 403].includes(error.status)) await read()
    } finally { unlock() }
  }
  const knownIds = draft?.email ? messageIds(draft.email) : []
  const evidencePositive = draft?.outcome === "accepted" || draft?.outcome === "delivered"
  const valid = Boolean(draft && draft.reason.trim().length >= 10 && draft.reason.trim().length <= 500 && opaqueReference.test(draft.reference.trim()) && (draft.action !== "verify_target" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.correctedEmail.trim())) && (draft.action !== "approve_identity" || draft.target?.state === "verified" && draft.target.provider_user_id && draft.target.verified_at) && (draft.action !== "record_email_evidence" || draft.email?.provider && draft.email.providerConfigurationId && knownIds.length <= 1 && (!evidencePositive || draft.messageId.trim().length > 0 && draft.messageId.trim().length <= 512 && !/[\r\n]/.test(draft.messageId))))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!safe || staleDraft || !draft || !valid || !steppedUp || mutating.current) return
    const inspected = draft
    lock(); setActionError(""); setNotice("")
    try {
      await reading.current
      const latest = current.current.data
      if (current.current.error || !latest?.runtime.runtimeEnabled || !matchesDraft(inspected, latest)) throw new RequestError(409, "Inspect the current revision.", "enrollment_revision_conflict")
      const common = { action: inspected.action, expectedRevision: inspected.revision, reason: inspected.reason.trim() }
      const body = inspected.action === "verify_target" ? { ...common, correctedEmail: inspected.correctedEmail.trim(), purchaseEvidence: inspected.reference.trim() }
        : inspected.action === "approve_identity" ? { ...common, verifiedProviderUserId: inspected.target!.provider_user_id, purchaseEvidence: inspected.reference.trim() }
        : inspected.action === "reissue_emails" ? { ...common, purchaseEvidence: inspected.reference.trim() }
        : { ...common, emailId: inspected.email!.id, outcome: inspected.outcome, evidence: inspected.reference.trim(), provider: inspected.email!.provider, providerConfigurationId: inspected.email!.providerConfigurationId, ...((knownIds.length || evidencePositive) ? { providerMessageId: inspected.messageId.trim() } : {}) }
      await requestJson(url, { method: "POST", credentials: "same-origin", body: JSON.stringify(body) })
      if (mounted.current) { setDraft(null); setSteppedUp(false); setCode(""); setNotice(`${names[inspected.action]} completed. Inspect refreshed observations before another action.`) }
      await read(); onUpdated()
    } catch (error: unknown) {
      if (mounted.current) { setSteppedUp(false); setCode(""); setActionError(error instanceof RequestError ? `Action rejected (${error.code}). Inspect current observations; nothing is automatically resubmitted.` : "Action could not be completed. Inspect current observations before retrying.") }
      if (error instanceof RequestError && [401, 403, 409].includes(error.status)) { await read(); onUpdated() }
    } finally { unlock() }
  }
  return <section aria-label="Enrollment detail" className="min-w-0 space-y-4 rounded-xl border p-4" aria-busy={loading || pending}>
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-lg font-semibold">Enrollment detail</h3><Button variant="outline" disabled={loading || pending} onClick={() => void read()}>Refresh detail</Button></div>
    <p className="break-all font-mono text-xs">{enrollmentId}</p>
    {loading && <p role="status">Loading enrollment detail…</p>}
    {observation.error && <p role="alert">{observation.error}</p>}
    {!queueSafe && <p role="alert">Queue access or freshness changed. Refresh the queue before taking an action.</p>}
    {data && <>
      <div className="flex flex-wrap gap-2"><PlatformStatus value={`Revision ${data.revision}`} /><PlatformStatus value={data.runtime.runtimeEnabled ? "Runtime enabled" : "Runtime disabled"} /><PlatformStatus value={data.runtime.creationEnabled ? "Creation enabled" : "Creation disabled"} /><PlatformStatus value={data.runtime.emailDispatchEnabled ? "Mail enabled" : "Mail disabled"} /></div>
      <p className="text-sm">Claim: {words(data.claimState)} · Recovery: {words(data.recoveryState)} · Billing: {words(data.billingState)} · Current mail generation: {data.emailGeneration}. Original trial ends: {data.trialEndsAt ?? "Not activated"}.</p>
      <p className="break-all text-sm text-muted-foreground">Saved purchase association: account {data.providerAccountId}; Checkout {data.checkoutSessionId ?? "None"}; subscription {data.subscriptionId ?? "None"}; {data.livemode ? "live" : "test"} mode. These saved observations are not a fresh provider verification. Flags do not prove scheduler or transport health.</p>
      {!data.runtime.runtimeEnabled && <p role="status">Runtime disabled: retained diagnostics remain readable; all recovery actions are disabled.</p>}
      <div className="space-y-2"><h4 className="font-semibold">Latest target verification</h4>{!data.targetVerification.length && <p>No target verification recorded.</p>}{data.targetVerification.map((target, index) => <div key={target.id} className="space-y-2 rounded-lg border p-3"><p className="break-all text-sm">Challenge {target.id}: {words(target.state)} · provider user {target.provider_user_id ?? "Not verified"} · verified {target.verified_at ?? "Not verified"}</p>{index === 0 && target.state === "verified" && target.provider_user_id && target.verified_at && <Button variant="outline" disabled={!safe || pending || !data.availableActions.includes("approve_identity")} onClick={() => begin("approve_identity", undefined, target)}>Review identity approval</Button>}</div>)}</div>
      <div className="space-y-3"><h4 className="font-semibold">Service mail history</h4><p className="text-sm text-muted-foreground">Accepted means transport acceptance; delivered records delivery evidence and does not prove the recipient read the message. Each generation retains its own receipts.</p>{data.emails.map(email => <article key={email.id} aria-label={`Mail ${email.id}`} className="min-w-0 space-y-2 rounded-lg border p-3">
        <h5 className="font-medium">{words(email.purpose)} · generation {email.generation}</h5><p className="break-all text-xs">{email.id}</p><div className="flex flex-wrap gap-2"><PlatformStatus value={email.state} /><span>{email.attempts} attempts · {Math.floor(email.ageSeconds / 60)} min old</span></div>
        <p className="break-all text-sm">Created {email.createdAt} · updated {email.updatedAt} · next attempt {email.nextAttemptAt} · error {email.errorCode ?? "None"} · superseded by {email.supersededByGeneration ?? "None"}.</p>
        <p className="break-all text-sm">Transport: {email.provider ?? "Not frozen"}; configuration: {email.providerConfigurationId ?? "Not frozen"} (unverified transport configuration). Projected message: {email.providerMessageId ?? "None"}.</p>
        {!email.receipts.length && <p className="text-sm">No receipt recorded.</p>}{email.receipts.map(receipt => <p key={receipt.id} className="break-all text-sm">Receipt: {words(receipt.state)} · {words(receipt.evidenceType)} · message {receipt.providerMessageId ?? "None"} · occurred {receipt.occurredAt} · observed {receipt.observedAt}.</p>)}
        {messageIds(email).length > 1 && <p role="alert">Conflicting durable message identities require investigation; evidence controls are disabled.</p>}
        <Button variant="outline" disabled={!safe || pending || !data.availableActions.includes("record_email_evidence") || !email.canRecordEvidence || !email.provider || !email.providerConfigurationId || messageIds(email).length > 1} onClick={() => begin("record_email_evidence", email)}>Review mail evidence</Button>
      </article>)}</div>
      <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={!safe || pending || !data.availableActions.includes("verify_target")} onClick={() => begin("verify_target")}>Review target verification</Button><Button variant="outline" disabled={!safe || pending || !data.availableActions.includes("reissue_emails")} onClick={() => begin("reissue_emails")}>Review service email reissue</Button></div>
    </>}
    {notice && <p role="status">{notice}</p>}
    {draft && <form onSubmit={submit} aria-label={`${names[draft.action]} draft`} className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <h4 className="font-semibold">{names[draft.action]}</h4><p className="text-sm">Inspected revision {draft.revision}. Refresh preserves this draft and never changes its target or revision.</p>
      {staleDraft && <p role="alert">This draft is stale. Discard it and review a new draft from the current observations.</p>}
      <p className="text-sm text-muted-foreground">Use an independently verified opaque case reference. A human assertion or MFA code alone is not purchase authority. Do not paste contact details, credentials or raw provider data into references or reasons.</p>
      {draft.action === "verify_target" && <><Label className="grid gap-2">Corrected target email<Input type="email" maxLength={320} value={draft.correctedEmail} onChange={event => update({ correctedEmail: event.target.value })} disabled={pending} /></Label><p className="text-sm">This starts the target’s normal email verification. It does not confirm an Auth account or approve an identity. After target verification, inspect its recorded proof and use a new operator MFA code for approval.</p></>}
      {draft.action === "approve_identity" && <p className="break-all text-sm">Inspected verified target {draft.target?.id}; provider user {draft.target?.provider_user_id}. Approval requires independent purchase proof and a new operator MFA step-up after the target’s email verification.</p>}
      {draft.action === "reissue_emails" && <p className="text-sm">Use the same independently approved purchase reference and a new operator MFA step-up after contact approval or the previous reissue. This requests two new service intents only when the server confirms eligibility; it does not replay uncertain mail.</p>}
      {draft.email && <><p className="break-all text-sm">Inspected mail {draft.email.id}, generation {draft.email.generation}; transport {draft.email.provider}; configuration {draft.email.providerConfigurationId} (unverified). Known durable message: {knownIds[0] ?? "None"}.</p><div className="grid gap-2"><Label htmlFor="onboarding-evidence-outcome">Evidence outcome</Label><select id="onboarding-evidence-outcome" value={draft.outcome} disabled={pending} onChange={event => update({ outcome: event.target.value as Outcome })} className="h-9 rounded-md border bg-background px-3">{(positiveHistory(draft.email) ? ["accepted", "delivered"] : ["accepted", "delivered", "failed", "suppressed"]).map(outcome => <option key={outcome}>{outcome}</option>)}</select></div>{(evidencePositive || knownIds.length > 0) && <Label className="grid gap-2">Provider message ID<Input maxLength={512} value={draft.messageId} readOnly={knownIds.length > 0} onChange={event => update({ messageId: event.target.value })} disabled={pending} /></Label>}<p className="text-sm">Positive evidence preserves the exact message’s durable ownership. Negative evidence cannot erase acceptance or delivery history.</p></>}
      <Label className="grid gap-2">{draft.action === "record_email_evidence" ? "Mail evidence reference" : "Purchase evidence reference"}<Input maxLength={200} value={draft.reference} onChange={event => update({ reference: event.target.value })} disabled={pending} /></Label>
      <Label className="grid gap-2">Action reason<Input minLength={10} maxLength={500} value={draft.reason} onChange={event => update({ reason: event.target.value })} disabled={pending} /></Label>
      <div className="space-y-2 rounded-lg border p-3"><Label className="grid gap-2">Authenticator code<Input autoComplete="one-time-code" inputMode="numeric" maxLength={32} value={code} onChange={event => setCode(event.target.value)} disabled={pending || !safe || staleDraft} /></Label><Button type="button" variant="outline" disabled={pending || !safe || staleDraft || !code.trim()} onClick={() => void verifyCode()}>Verify code</Button>{steppedUp && <p role="status">Step-up verified for this draft.</p>}</div>
      {actionError && <p role="alert">{actionError}</p>}
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={!safe || staleDraft || pending || !valid || !steppedUp}>{pending ? "Action pending…" : `Submit ${names[draft.action].toLowerCase()}`}</Button><Button type="button" variant="outline" disabled={pending} onClick={() => { setDraft(null); setCode(""); setSteppedUp(false); setActionError("") }}>Discard draft</Button></div>
    </form>}
  </section>
}
