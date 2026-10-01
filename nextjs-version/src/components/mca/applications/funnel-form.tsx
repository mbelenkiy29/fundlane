"use client"

import * as React from "react"
import { ArrowLeft, ArrowRight, Check, Loader2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestJson } from "@/lib/mca/client"
import { uploadMultipart } from "@/components/mca/documents/upload"
import type { ApplicationSession, InvitationFileView } from "@/lib/mca/applications/contracts"
import {
  ENTITY_TYPE_LABELS, ENTITY_TYPES, US_STATES, visibleSteps, stepError, parseMoneyInput, type FunnelStepId,
} from "@/lib/mca/applications/form-schema"
import { applicationFileError, mergeUploadedSession, saveThenSubmit } from "@/lib/mca/applications/funnel-session"
import { isDocumentReady } from "@/lib/mca/documents/contracts"
import type { DealOwnerInput, DealWriteInput, EntityType } from "@/lib/mca/deals/schema"

export function FunnelForm({ token, initial }: { token: string; initial: ApplicationSession }) {
  const [session, setSession] = React.useState(initial)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [savedAndExited, setSavedAndExited] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const inFlight = React.useRef(false)
  const [uploadPct, setUploadPct] = React.useState<number | null>(null)
  const answers = session.answers
  const steps = visibleSteps(session.branding.optionalFields)
  const index = Math.max(0, steps.findIndex(step => step.id === session.step))
  const current = steps[index] ?? steps[0]
  const accent = session.branding.accent || undefined
  const progress = session.submitted ? 100 : Math.round((index / Math.max(1, steps.length - 1)) * 100)

  async function saveDraft(step: FunnelStepId, next: DealWriteInput) {
    const updated = await requestJson<ApplicationSession>("/api/applications/session", { method: "PATCH", body: JSON.stringify({ token, step, answers: next }) })
    setSession(updated)
    setSaved(true)
    return updated
  }

  async function run(work: () => Promise<void>, fallback: string) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setError("")
    try { await work() }
    catch (reason) { setError(reason instanceof Error ? reason.message : fallback) }
    finally { inFlight.current = false; setBusy(false) }
  }

  async function saveAndExit() {
    await run(async () => {
      await saveDraft(session.step, answers)
      setSavedAndExited(true)
    }, "Could not save your progress.")
  }

  async function refreshFiles() {
    await run(async () => {
      const refreshed = await requestJson<ApplicationSession>(`/api/applications/session?token=${encodeURIComponent(token)}`)
      setSession(currentSession => mergeUploadedSession(currentSession, refreshed))
    }, "Could not refresh file status.")
  }


  function patch(partial: DealWriteInput) {
    setSaved(false)
    setError("")
    setSession(currentSession => ({ ...currentSession, answers: { ...currentSession.answers, ...partial } }))
  }

  async function go(delta: number) {
    const target = steps[index + delta]
    if (!target) return
    if (delta > 0) {
      const message = stepError(current.id, answers, session.branding.optionalFields)
      if (message) { setError(message); return }
      if (current.id === "statements") {
        const fileError = applicationFileError(session.files, session.requiredStatementMonths)
        if (fileError) { setError(fileError); return }
      }
    }
    await run(async () => { await saveDraft(target.id, answers) }, "Could not save your progress.")
  }

  async function upload(category: InvitationFileView["category"], file: File) {
    await run(async () => {
      setUploadPct(0)
      try {
        const form = new FormData()
        form.set("token", token)
        form.set("category", category)
        form.set("idempotencyKey", crypto.randomUUID())
        form.set("file", file)
        const uploaded = await uploadMultipart<ApplicationSession>("/api/applications/files", form, setUploadPct)
        setSession(currentSession => mergeUploadedSession(currentSession, uploaded))
      } catch (reason) {
        // Rejected scans can still persist a blocked row. Keep the list current
        // and preserve partial answers even when the upload response is an error.
        let refreshed: ApplicationSession | undefined
        try { refreshed = await requestJson<ApplicationSession>(`/api/applications/session?token=${encodeURIComponent(token)}`) } catch { /* Keep the original upload error. */ }
        if (refreshed) {
          setSession(currentSession => mergeUploadedSession(currentSession, refreshed!))
          if (refreshed.files.some(file => !isDocumentReady(file.processingState))) {
            throw new Error(applicationFileError(refreshed.files, session.requiredStatementMonths))
          }
        }
        throw reason
      } finally { setUploadPct(null) }
    }, "Upload failed. Try another file.")
  }

  async function submit() {
    const fileError = applicationFileError(session.files, session.requiredStatementMonths)
    if (fileError) { setError(fileError); return }
    await run(async () => {
      const submitted = await saveThenSubmit(session, saveDraft, () => requestJson<ApplicationSession>("/api/applications/submit", { method: "POST", body: JSON.stringify({ token }) }))
      setSession(submitted)
    }, "The application could not be submitted.")
  }

  if (session.submitted) {
    return <div className="rounded-xl border bg-card p-8 sm:p-12">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="size-6" /></div>
      <h2 className="text-2xl font-semibold tracking-tight">{session.branding.thankYouTitle}</h2>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">Thank you. {session.employeeName} will review your application and follow up.</p>
    </div>
  }

  if (savedAndExited) return <div className="rounded-xl border bg-card p-6 sm:p-10">
    <h2 className="text-2xl font-semibold">Your progress is saved</h2>
    <p role="status" className="mt-3 text-sm text-muted-foreground">Return using the same invitation link to finish your application. Your link expires on {new Date(session.expiresAt).toLocaleDateString()}.</p>
    <Button className="mt-6" onClick={() => setSavedAndExited(false)}>Resume application</Button>
  </div>

  return <div className="overflow-hidden rounded-xl border bg-card shadow-sm" style={accent ? { ["--primary" as string]: accent } : undefined}>
    <div className="h-1 bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>
    <div className="p-6 sm:p-10">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Step {index + 1} of {steps.length}</p>
      <h2 className="mt-3 max-w-xl text-2xl font-semibold tracking-tight sm:text-3xl">{current.id === "welcome" ? session.branding.welcomeTitle : current.title}</h2>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{current.id === "welcome" ? session.branding.welcomeBody : current.hint}</p>
      <fieldset disabled={busy} className="mt-8 min-w-0 max-w-lg space-y-4">
        {current.id === "legalName" && <Field label="Legal business name" value={answers.legalName ?? ""} onChange={value => patch({ legalName: value })} />}
        {current.id === "dbaName" && <Field label="DBA (optional)" value={answers.dbaName ?? ""} onChange={value => patch({ dbaName: value })} />}
        {current.id === "entityType" && <select aria-label="Entity type" className="h-11 w-full rounded-md border bg-background px-3 text-base" value={answers.entityType ?? ""} onChange={event => patch({ entityType: event.target.value as EntityType })}>
          <option value="">Choose entity type</option>
          {ENTITY_TYPES.map(type => <option key={type} value={type}>{ENTITY_TYPE_LABELS[type]}</option>)}
        </select>}
        {current.id === "ein" && <Field label="EIN" inputMode="numeric" value={answers.ein ?? ""} onChange={value => patch({ ein: value })} />}
        {current.id === "address" && <AddressFields address={answers.address} onChange={address => patch({ address })} />}
        {current.id === "startDate" && <Field label="Start date" type="date" value={answers.startDate ?? ""} onChange={value => patch({ startDate: value })} />}
        {current.id === "industry" && <Field label="Industry" value={answers.industry ?? ""} onChange={value => patch({ industry: value })} />}
        {current.id === "monthlyRevenue" && <Field preserveInput label="Monthly deposits" inputMode="decimal" value={answers.monthlyRevenue?.toString() ?? ""} onChange={value => patch({ monthlyRevenue: parseMoneyInput(value) })} />}
        {current.id === "requestedAmount" && <Field preserveInput label="Requested amount" inputMode="decimal" value={answers.requestedAmount?.toString() ?? ""} onChange={value => patch({ requestedAmount: parseMoneyInput(value) })} />}
        {current.id === "fundingPurpose" && <Field label="Use of funds" value={answers.fundingPurpose ?? ""} onChange={value => patch({ fundingPurpose: value })} />}
        {current.id === "contact" && <>
          <Field label="Contact name" value={answers.contactName ?? ""} onChange={value => patch({ contactName: value })} />
          <Field label="Email" value={session.contactEmail} onChange={() => undefined} disabled />
          <Field label="Phone" value={answers.contactPhone ?? ""} onChange={value => patch({ contactPhone: value })} />
        </>}
        {current.id === "owners" && <OwnersFields owners={answers.owners ?? [{ firstName: "", lastName: "", ownershipPercent: 100, isPrimary: true }]} onChange={owners => patch({ owners })} />}
        {current.id === "statements" && <FileStep files={session.files.filter(file => file.category === "statement")} required={session.requiredStatementMonths} busy={busy} percent={uploadPct} onUpload={file => void upload("statement", file)} />}
        {current.id === "extras" && <div className="space-y-4">
          {session.branding.optionalFields.driversLicense && <FileStep label="Driver’s license or ID" files={session.files.filter(file => file.category === "driver_license")} required={0} busy={busy} percent={uploadPct} onUpload={file => void upload("driver_license", file)} />}
          {session.branding.optionalFields.voidedCheck && <FileStep label="Voided check" files={session.files.filter(file => file.category === "voided_check")} required={0} busy={busy} percent={uploadPct} onUpload={file => void upload("voided_check", file)} />}
        </div>}
        {current.id === "review" && <><Review answers={answers} files={session.files} email={session.contactEmail} />{applicationFileError(session.files, session.requiredStatementMonths) && <p role="alert" className="text-sm text-destructive">{applicationFileError(session.files, session.requiredStatementMonths)}</p>}</>}
      </fieldset>
      {(current.id === "statements" || current.id === "extras" || current.id === "review") && <Button variant="outline" className="mt-4" disabled={busy} onClick={() => void refreshFiles()}>Refresh file status</Button>}
      <p role="status" className="mt-4 text-xs text-muted-foreground">{busy ? "Working…" : saved ? "Progress saved. Use this invitation link to resume." : "Use Save and exit to keep your progress and finish later."}</p>
      {error && <p role="alert" className="mt-6 text-sm text-destructive">{error}</p>}
      <div className="mt-8 flex flex-wrap gap-3">
        {index > 0 && <Button type="button" variant="outline" disabled={busy} onClick={() => void go(-1)}><ArrowLeft className="size-4" />Back</Button>}
        {current.id === "review"
          ? <Button type="button" disabled={busy || Boolean(applicationFileError(session.files, session.requiredStatementMonths))} onClick={() => void submit()}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}{busy ? "Submitting…" : "Submit application"}</Button>
          : current.id === "welcome"
            ? <Button type="button" disabled={busy} onClick={() => void go(1)}>Continue<ArrowRight className="size-4" /></Button>
            : <Button type="button" disabled={busy} onClick={() => void go(1)}>{busy ? "Saving…" : "Continue"}<ArrowRight className="size-4" /></Button>}
        <Button type="button" variant="outline" disabled={busy} onClick={() => void saveAndExit()}>Save and exit</Button>
      </div>
    </div>
  </div>
}

function Field({ label, value, onChange, type = "text", inputMode, disabled, preserveInput }: { label: string; value: string; onChange: (value: string) => void; type?: string; inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]; disabled?: boolean; preserveInput?: boolean }) {
  const id = React.useId()
  const [editing, setEditing] = React.useState(false)
  const [raw, setRaw] = React.useState(value)
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><Input id={id} className="h-11 text-base" type={type} inputMode={inputMode} value={preserveInput && editing ? raw : value} disabled={disabled} onFocus={() => { setRaw(value); setEditing(true) }} onBlur={() => setEditing(false)} onChange={event => { setRaw(event.target.value); onChange(event.target.value) }} /></div>
}

function AddressFields({ address, onChange }: { address: DealWriteInput["address"]; onChange: (address: NonNullable<DealWriteInput["address"]>) => void }) {
  const value = address ?? {}
  const set = (patch: Partial<NonNullable<DealWriteInput["address"]>>) => onChange({ ...value, country: "US", ...patch })
  return <div className="grid gap-4">
    <Field label="Street" value={value.line1 ?? ""} onChange={line1 => set({ line1 })} />
    <Field label="City" value={value.city ?? ""} onChange={city => set({ city })} />
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-2"><Label htmlFor="state">State</Label><select id="state" className="h-11 w-full rounded-md border bg-background px-3 text-base" value={value.state ?? ""} onChange={event => set({ state: event.target.value })}>
        <option value="">State</option>
        {US_STATES.map(state => <option key={state} value={state}>{state}</option>)}
      </select></div>
      <Field label="ZIP" value={value.postalCode ?? ""} onChange={postalCode => set({ postalCode })} />
    </div>
  </div>
}

function OwnersFields({ owners, onChange }: { owners: DealOwnerInput[]; onChange: (owners: DealOwnerInput[]) => void }) {
  function update(index: number, patch: DealOwnerInput) {
    onChange(owners.map((owner, item) => item === index ? { ...owner, ...patch } : owner))
  }
  return <div className="space-y-6">
    {owners.map((owner, index) => <div key={index} className="space-y-3 rounded-lg border p-4">
      <p className="text-sm font-medium">Owner {index + 1}</p>
      <Field label="First name" value={owner.firstName ?? ""} onChange={firstName => update(index, { firstName })} />
      <Field label="Last name" value={owner.lastName ?? ""} onChange={lastName => update(index, { lastName })} />
      <Field preserveInput label="Ownership %" inputMode="decimal" value={owner.ownershipPercent?.toString() ?? ""} onChange={value => update(index, { ownershipPercent: parseMoneyInput(value) })} />
      <Field label="SSN last four (optional)" inputMode="numeric" value={owner.identityLast4 ?? ""} onChange={identityLast4 => update(index, { identityLast4 })} />
      {owners.length > 1 && <Button type="button" variant="outline" onClick={() => onChange(owners.filter((_, item) => item !== index))}>Remove owner {index + 1}</Button>}
    </div>)}
    {owners.length < 6 && <Button type="button" variant="outline" onClick={() => onChange([...owners, { firstName: "", lastName: "", ownershipPercent: 0 }])}>Add another owner</Button>}
  </div>
}

function FileStep({ files, required, busy, percent, onUpload, label }: { files: InvitationFileView[]; required: number; busy: boolean; percent: number | null; onUpload: (file: File) => void; label?: string }) {
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">{label ?? (required ? `Upload the ${required} most recent monthly bank statements.` : "Optional supporting document.")} PDF, PNG, or JPEG; up to 25 MB per file.</p>
    {required > 0 && <p role="status" className="text-sm">{files.filter(file => isDocumentReady(file.processingState)).length} of {required} required statements accepted</p>}
    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-4 py-6 text-sm">
      <Upload className="size-4" />
      <span>{busy && percent != null ? `Uploading ${percent}%` : "Choose file"}</span>
      <input className="sr-only" type="file" accept="application/pdf,image/png,image/jpeg" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = "" }} />
    </label>
    <ul className="space-y-1 text-sm">{files.map(file => <li key={file.id} className="break-words [overflow-wrap:anywhere]">{file.filename} · {isDocumentReady(file.processingState) ? "Accepted" : file.processingState === "pending_scan" ? "Waiting for file checks" : "Not accepted — contact your representative if this persists"}</li>)}</ul>
  </div>
}

function Review({ answers, files, email }: { answers: DealWriteInput; files: InvitationFileView[]; email: string }) {
  const rows: [string, string][] = [
    ["Legal name", answers.legalName ?? "—"],
    ["EIN", answers.ein ?? "—"],
    ["Requested", answers.requestedAmount != null ? `$${answers.requestedAmount.toLocaleString()}` : "—"],
    ["Contact", [answers.contactName, email, answers.contactPhone].filter(Boolean).join(" · ")],
    ["Statements", String(files.filter(file => file.category === "statement" && isDocumentReady(file.processingState)).length)],
  ]
  return <dl className="space-y-3 text-sm">{rows.map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words text-right font-medium [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>
}
