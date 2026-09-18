"use client"

import * as React from "react"
import { ArrowLeft, ArrowRight, Check, Loader2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestJson, RequestError } from "@/lib/mca/client"
import { uploadMultipart } from "@/components/mca/documents/upload"
import type { ApplicationSession, InvitationFileView } from "@/lib/mca/applications/contracts"
import {
  ENTITY_TYPE_LABELS, ENTITY_TYPES, US_STATES, visibleSteps, stepError, type FunnelStepId,
} from "@/lib/mca/applications/form-schema"
import type { DealOwnerInput, DealWriteInput, EntityType } from "@/lib/mca/deals/schema"

export function FunnelForm({ token, initial }: { token: string; initial: ApplicationSession }) {
  const [session, setSession] = React.useState(initial)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [uploadPct, setUploadPct] = React.useState<number | null>(null)
  const answers = session.answers
  const steps = visibleSteps(session.branding.optionalFields)
  const index = Math.max(0, steps.findIndex(step => step.id === session.step))
  const current = steps[index] ?? steps[0]
  const accent = session.branding.accent || undefined
  const progress = session.submitted ? 100 : Math.round((index / Math.max(1, steps.length - 1)) * 100)

  async function persist(step: FunnelStepId, next: DealWriteInput) {
    setBusy(true); setError("")
    try {
      setSession(await requestJson<ApplicationSession>("/api/applications/session", { method: "PATCH", body: JSON.stringify({ token, step, answers: next }) }))
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save your progress.") }
    finally { setBusy(false) }
  }

  React.useEffect(() => {
    const save = () => {
      if (session.submitted) return
      void fetch("/api/applications/session", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, step: session.step, answers: session.answers }), keepalive: true })
    }
    const hide = () => { if (document.visibilityState === "hidden") save() }
    window.addEventListener("pagehide", save)
    document.addEventListener("visibilitychange", hide)
    return () => { window.removeEventListener("pagehide", save); document.removeEventListener("visibilitychange", hide) }
  }, [token, session.step, session.answers, session.submitted])

  function patch(partial: DealWriteInput) {
    setSession(currentSession => ({ ...currentSession, answers: { ...currentSession.answers, ...partial } }))
  }

  async function go(delta: number) {
    const target = steps[index + delta]
    if (!target) return
    if (delta > 0) {
      const message = stepError(current.id, answers, session.branding.optionalFields)
      if (message) { setError(message); return }
      if (current.id === "statements" && session.files.filter(file => file.category === "statement").length < session.requiredStatementMonths) {
        setError(`Upload at least ${session.requiredStatementMonths} bank statements.`)
        return
      }
    }
    await persist(target.id, answers)
  }

  async function upload(category: InvitationFileView["category"], file: File) {
    setBusy(true); setError(""); setUploadPct(0)
    try {
      const form = new FormData()
      form.set("token", token)
      form.set("category", category)
      form.set("idempotencyKey", crypto.randomUUID())
      form.set("file", file)
      setSession(await uploadMultipart<ApplicationSession>("/api/applications/files", form, setUploadPct))
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Upload failed. Try another file.") }
    finally { setBusy(false); setUploadPct(null) }
  }

  async function submit() {
    setBusy(true); setError("")
    try {
      await persist("review", answers)
      setSession(await requestJson<ApplicationSession>("/api/applications/submit", { method: "POST", body: JSON.stringify({ token }) }))
    } catch (reason) { setError(reason instanceof RequestError ? reason.message : reason instanceof Error ? reason.message : "The application could not be submitted.") }
    finally { setBusy(false) }
  }

  if (session.submitted) {
    return <div className="rounded-xl border bg-card p-8 sm:p-12">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="size-6" /></div>
      <h2 className="text-2xl font-semibold tracking-tight">{session.branding.thankYouTitle}</h2>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">Thank you. {session.employeeName} will review your application and follow up.</p>
    </div>
  }

  return <div className="overflow-hidden rounded-xl border bg-card shadow-sm" style={accent ? { ["--primary" as string]: accent } : undefined}>
    <div className="h-1 bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>
    <div className="p-6 sm:p-10">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Step {index + 1} of {steps.length}</p>
      <h2 className="mt-3 max-w-xl text-2xl font-semibold tracking-tight sm:text-3xl">{current.id === "welcome" ? session.branding.welcomeTitle : current.title}</h2>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{current.id === "welcome" ? session.branding.welcomeBody : current.hint}</p>
      <div className="mt-8 max-w-lg space-y-4">
        {current.id === "legalName" && <Field label="Legal business name" value={answers.legalName ?? ""} onChange={value => patch({ legalName: value })} />}
        {current.id === "dbaName" && <Field label="DBA (optional)" value={answers.dbaName ?? ""} onChange={value => patch({ dbaName: value })} />}
        {current.id === "entityType" && <select className="h-11 w-full rounded-md border bg-background px-3 text-base" value={answers.entityType ?? ""} onChange={event => patch({ entityType: event.target.value as EntityType })}>
          <option value="">Choose entity type</option>
          {ENTITY_TYPES.map(type => <option key={type} value={type}>{ENTITY_TYPE_LABELS[type]}</option>)}
        </select>}
        {current.id === "ein" && <Field label="EIN" inputMode="numeric" value={answers.ein ?? ""} onChange={value => patch({ ein: value })} />}
        {current.id === "address" && <AddressFields address={answers.address} onChange={address => patch({ address })} />}
        {current.id === "startDate" && <Field label="Start date" type="date" value={answers.startDate ?? ""} onChange={value => patch({ startDate: value })} />}
        {current.id === "industry" && <Field label="Industry" value={answers.industry ?? ""} onChange={value => patch({ industry: value })} />}
        {current.id === "monthlyRevenue" && <Field label="Monthly deposits" inputMode="decimal" value={answers.monthlyRevenue?.toString() ?? ""} onChange={value => patch({ monthlyRevenue: Number(value.replace(/[$,]/g, "")) || undefined })} />}
        {current.id === "requestedAmount" && <Field label="Requested amount" inputMode="decimal" value={answers.requestedAmount?.toString() ?? ""} onChange={value => patch({ requestedAmount: Number(value.replace(/[$,]/g, "")) || undefined })} />}
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
        {current.id === "review" && <Review answers={answers} files={session.files} email={session.contactEmail} />}
      </div>
      {error && <p role="alert" className="mt-6 text-sm text-destructive">{error}</p>}
      <div className="mt-8 flex flex-wrap gap-3">
        {index > 0 && <Button type="button" variant="outline" disabled={busy} onClick={() => void go(-1)}><ArrowLeft className="size-4" />Back</Button>}
        {current.id === "review"
          ? <Button type="button" disabled={busy} onClick={() => void submit()}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}{busy ? "Submitting…" : "Submit application"}</Button>
          : current.id === "welcome"
            ? <Button type="button" disabled={busy} onClick={() => void go(1)}>Continue<ArrowRight className="size-4" /></Button>
            : <Button type="button" disabled={busy} onClick={() => void go(1)}>{busy ? "Saving…" : "Continue"}<ArrowRight className="size-4" /></Button>}
      </div>
    </div>
  </div>
}

function Field({ label, value, onChange, type = "text", inputMode, disabled }: { label: string; value: string; onChange: (value: string) => void; type?: string; inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]; disabled?: boolean }) {
  const id = React.useId()
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><Input id={id} className="h-11 text-base" type={type} inputMode={inputMode} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} /></div>
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
      <Field label="Ownership %" inputMode="decimal" value={owner.ownershipPercent?.toString() ?? ""} onChange={value => update(index, { ownershipPercent: Number(value) || undefined })} />
      <Field label="SSN last four (optional)" inputMode="numeric" value={owner.identityLast4 ?? ""} onChange={identityLast4 => update(index, { identityLast4 })} />
    </div>)}
    {owners.length < 6 && <Button type="button" variant="outline" onClick={() => onChange([...owners, { firstName: "", lastName: "", ownershipPercent: 0 }])}>Add another owner</Button>}
  </div>
}

function FileStep({ files, required, busy, percent, onUpload, label }: { files: InvitationFileView[]; required: number; busy: boolean; percent: number | null; onUpload: (file: File) => void; label?: string }) {
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">{label ?? (required ? `PDF, PNG, or JPEG. ${required} required.` : "PDF, PNG, or JPEG.")}</p>
    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-4 py-6 text-sm">
      <Upload className="size-4" />
      <span>{busy && percent != null ? `Uploading ${percent}%` : "Choose files"}</span>
      <input className="sr-only" type="file" accept="application/pdf,image/png,image/jpeg" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = "" }} />
    </label>
    <ul className="space-y-1 text-sm">{files.map(file => <li key={file.id}>{file.filename} · {file.processingState.replace("_", " ")}</li>)}</ul>
  </div>
}

function Review({ answers, files, email }: { answers: DealWriteInput; files: InvitationFileView[]; email: string }) {
  const rows: [string, string][] = [
    ["Legal name", answers.legalName ?? "—"],
    ["EIN", answers.ein ?? "—"],
    ["Requested", answers.requestedAmount != null ? `$${answers.requestedAmount.toLocaleString()}` : "—"],
    ["Contact", [answers.contactName, email, answers.contactPhone].filter(Boolean).join(" · ")],
    ["Statements", String(files.filter(file => file.category === "statement").length)],
  ]
  return <dl className="space-y-3 text-sm">{rows.map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="text-right font-medium">{value}</dd></div>)}</dl>
}
