"use client"

import { Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  ENTITY_TYPES,
  type DealOwnerInput,
  type DealWriteInput,
} from "@/lib/mca/deals/schema"

export interface DraftForm {
  legalName: string; dbaName: string; ein: string; entityType: string; line1: string; city: string; state: string; postalCode: string
  contactName: string; contactEmail: string; contactPhone: string; startDate: string; industry: string; naicsCode: string
  monthlyRevenue: string; ficoScore: string; fundingPurpose: string; requestedAmount: string
  owners: DealOwnerInput[]; originators: string; closers: string
}

export const emptyDraft = (): DraftForm => ({
  legalName: "", dbaName: "", ein: "", entityType: "", line1: "", city: "", state: "", postalCode: "",
  contactName: "", contactEmail: "", contactPhone: "", startDate: "", industry: "", naicsCode: "", monthlyRevenue: "",
  ficoScore: "", fundingPurpose: "", requestedAmount: "", owners: [], originators: "", closers: "",
})

export function applyWriteInput(form: DraftForm, fields: DealWriteInput): DraftForm {
  return {
    ...form,
    legalName: fields.legalName ?? form.legalName,
    dbaName: fields.dbaName ?? form.dbaName,
    ein: fields.ein ?? form.ein,
    entityType: fields.entityType ?? form.entityType,
    line1: fields.address?.line1 ?? form.line1,
    city: fields.address?.city ?? form.city,
    state: fields.address?.state ?? form.state,
    postalCode: fields.address?.postalCode ?? form.postalCode,
    contactName: fields.contactName ?? form.contactName,
    contactEmail: fields.contactEmail ?? form.contactEmail,
    contactPhone: fields.contactPhone ?? form.contactPhone,
    startDate: fields.startDate ?? form.startDate,
    industry: fields.industry ?? form.industry,
    naicsCode: fields.naicsCode ?? form.naicsCode,
    monthlyRevenue: fields.monthlyRevenue != null ? String(fields.monthlyRevenue) : form.monthlyRevenue,
    ficoScore: fields.ficoScore != null ? String(fields.ficoScore) : form.ficoScore,
    fundingPurpose: fields.fundingPurpose ?? form.fundingPurpose,
    requestedAmount: fields.requestedAmount != null ? String(fields.requestedAmount) : form.requestedAmount,
    owners: fields.owners ?? form.owners,
  }
}

export function formPayload(form: DraftForm) {
  const ids = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean)
  const originators = ids(form.originators)
  const closers = ids(form.closers)
  return {
    legalName: form.legalName || undefined, dbaName: form.dbaName || undefined, ein: form.ein || undefined,
    entityType: form.entityType || undefined,
    address: { line1: form.line1 || undefined, city: form.city || undefined, state: form.state || undefined, postalCode: form.postalCode || undefined },
    contactName: form.contactName || undefined, contactEmail: form.contactEmail || undefined, contactPhone: form.contactPhone || undefined,
    startDate: form.startDate || undefined, industry: form.industry || undefined, naicsCode: form.naicsCode || undefined,
    monthlyRevenue: form.monthlyRevenue ? Number(form.monthlyRevenue) : undefined,
    ficoScore: form.ficoScore ? Number(form.ficoScore) : undefined,
    fundingPurpose: form.fundingPurpose || undefined, requestedAmount: form.requestedAmount ? Number(form.requestedAmount) : undefined,
    owners: form.owners,
    assignments: originators.length || closers.length ? [
      ...originators.map((membershipId, index) => ({ membershipId, kind: "originator" as const, isPrimary: index === 0 })),
      ...closers.map((membershipId, index) => ({ membershipId, kind: "closer" as const, isPrimary: index === 0 })),
    ] : undefined,
    fieldSource: "manual" as const,
  }
}

function FormField({ id, label, value, onChange, type = "text", placeholder, error }: { id?: string; label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; error?: string }) {
  const inputId = id ? `${id}-input` : undefined
  return <div id={id} className="scroll-mt-4 space-y-1.5"><Label htmlFor={inputId}>{label}</Label><Input id={inputId} type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-invalid={Boolean(error)} />{error && <p className="text-xs text-destructive">{error}</p>}</div>
}

export function DealForm({ form, setForm, fieldErrors }: { form: DraftForm; setForm: (value: DraftForm) => void; fieldErrors: Record<string, string[]> }) {
  const set = (key: keyof DraftForm, value: string) => setForm({ ...form, [key]: value })
  const updateOwner = (index: number, patch: Partial<DealOwnerInput>) => setForm({ ...form, owners: form.owners.map((owner, ownerIndex) => ownerIndex === index ? { ...owner, ...patch } : owner) })
  return <div className="space-y-6 py-2">
    <section className="space-y-3"><div><h3 className="font-medium">Business</h3><p className="text-xs text-muted-foreground">Save at any point. Missing submission fields stay flagged on the record.</p></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="deal-field-legalName" label="Legal name" value={form.legalName} onChange={(value) => set("legalName", value)} error={fieldErrors.legalName?.[0]} />
        <FormField label="DBA" value={form.dbaName} onChange={(value) => set("dbaName", value)} />
        <FormField label="EIN" value={form.ein} onChange={(value) => set("ein", value)} placeholder="12-3456789" error={fieldErrors.ein?.[0]} />
        <div id="deal-field-entityType" className="scroll-mt-4 space-y-1.5"><Label htmlFor="deal-field-entityType-trigger">Entity type</Label><Select value={form.entityType} onValueChange={(value) => set("entityType", value)}><SelectTrigger id="deal-field-entityType-trigger"><SelectValue placeholder="Choose type" /></SelectTrigger><SelectContent>{ENTITY_TYPES.map((item) => <SelectItem value={item} key={item}>{item.replace(/_/g, " ")}</SelectItem>)}</SelectContent></Select></div>
        <FormField label="Contact name" value={form.contactName} onChange={(value) => set("contactName", value)} />
        <FormField label="Contact email" value={form.contactEmail} onChange={(value) => set("contactEmail", value)} type="email" error={fieldErrors.contactEmail?.[0]} />
        <FormField id="deal-field-contactPhone" label="Contact phone" value={form.contactPhone} onChange={(value) => set("contactPhone", value)} />
        <FormField id="deal-field-startDate" label="Business start date" value={form.startDate} onChange={(value) => set("startDate", value)} type="date" error={fieldErrors.startDate?.[0]} />
      </div>
    </section>
    <section className="space-y-3"><h3 className="font-medium">Address & criteria</h3><div className="grid gap-3 sm:grid-cols-2">
      <FormField id="deal-field-line1" label="Street address" value={form.line1} onChange={(value) => set("line1", value)} /><FormField id="deal-field-city" label="City" value={form.city} onChange={(value) => set("city", value)} />
      <FormField id="deal-field-state" label="State" value={form.state} onChange={(value) => set("state", value)} /><FormField id="deal-field-postalCode" label="ZIP code" value={form.postalCode} onChange={(value) => set("postalCode", value)} />
      <FormField id="deal-field-industry" label="Industry" value={form.industry} onChange={(value) => set("industry", value)} /><FormField label="NAICS" value={form.naicsCode} onChange={(value) => set("naicsCode", value)} error={fieldErrors.naicsCode?.[0]} />
      <FormField id="deal-field-monthlyRevenue" label="Monthly revenue" value={form.monthlyRevenue} onChange={(value) => set("monthlyRevenue", value)} type="number" error={fieldErrors.monthlyRevenue?.[0]} />
      <FormField label="FICO" value={form.ficoScore} onChange={(value) => set("ficoScore", value)} type="number" error={fieldErrors.ficoScore?.[0]} />
      <FormField id="deal-field-requestedAmount" label="Requested funding" value={form.requestedAmount} onChange={(value) => set("requestedAmount", value)} type="number" error={fieldErrors.requestedAmount?.[0]} />
      <FormField id="deal-field-fundingPurpose" label="Use of funds" value={form.fundingPurpose} onChange={(value) => set("fundingPurpose", value)} />
    </div></section>
    <section id="deal-field-owners" className="scroll-mt-4 space-y-3"><div className="flex items-center justify-between"><h3 className="font-medium">Owners</h3><Button type="button" variant="outline" size="sm" onClick={() => setForm({ ...form, owners: [...form.owners, { isPrimary: form.owners.length === 0 }] })}><Plus className="mr-1 size-3.5" />Add owner</Button></div>
      {form.owners.length === 0 ? <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No owners yet.</div> : form.owners.map((owner, index) => <div className="relative grid gap-3 rounded-lg border p-3 sm:grid-cols-2" key={owner.id ?? index}>
        <Button type="button" variant="ghost" size="icon" aria-label={`Remove owner ${index + 1}`} className="absolute right-1 top-1 size-7" onClick={() => setForm({ ...form, owners: form.owners.filter((_, ownerIndex) => ownerIndex !== index) })}><X className="size-3.5" /></Button>
        <FormField id={`deal-field-owners-${index}-firstName`} label="First name" value={owner.firstName ?? ""} onChange={(value) => updateOwner(index, { firstName: value })} error={fieldErrors[`owners.${index}.firstName`]?.[0]} /><FormField id={`deal-field-owners-${index}-lastName`} label="Last name" value={owner.lastName ?? ""} onChange={(value) => updateOwner(index, { lastName: value })} error={fieldErrors[`owners.${index}.lastName`]?.[0]} />
        <FormField id={`deal-field-owners-${index}-ownershipPercent`} label="Ownership %" value={owner.ownershipPercent?.toString() ?? ""} onChange={(value) => updateOwner(index, { ownershipPercent: value ? Number(value) : undefined })} type="number" error={fieldErrors[`owners.${index}.ownershipPercent`]?.[0]} />
        <FormField label="Date of birth" value={owner.dateOfBirth ?? ""} onChange={(value) => updateOwner(index, { dateOfBirth: value })} type={owner.dateOfBirth?.includes("•") ? "text" : "date"} error={fieldErrors[`owners.${index}.dateOfBirth`]?.[0]} />
        <FormField label="Identity last 4" value={owner.identityLast4 ?? ""} onChange={(value) => updateOwner(index, { identityLast4: value })} error={fieldErrors[`owners.${index}.identityLast4`]?.[0]} /><FormField label="Email" value={owner.email ?? ""} onChange={(value) => updateOwner(index, { email: value })} error={fieldErrors[`owners.${index}.email`]?.[0]} />
        <FormField label="Phone" value={owner.phone ?? ""} onChange={(value) => updateOwner(index, { phone: value })} />
      </div>)}{fieldErrors.owners?.map((error) => <p className="text-xs text-destructive" key={error}>{error}</p>)}</section>
    <section className="space-y-3"><div><h3 className="font-medium">Assignments</h3><p className="text-xs text-muted-foreground">Enter active membership IDs, separated by commas. The first is primary.</p></div><div className="grid gap-3 sm:grid-cols-2"><FormField label="Originators" value={form.originators} onChange={(value) => set("originators", value)} /><FormField label="Closers" value={form.closers} onChange={(value) => set("closers", value)} /></div></section>
  </div>
}
