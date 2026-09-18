"use client"

import * as React from "react"
import { FileCheck2, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RequestError } from "@/lib/mca/client"

const CATEGORIES = [
  { key: "statement", label: "Bank statements", accept: "application/pdf,image/png,image/jpeg" },
  { key: "driver_license", label: "Photo ID", accept: "application/pdf,image/png,image/jpeg" },
  { key: "voided_check", label: "Voided check", accept: "application/pdf,image/png,image/jpeg" },
] as const

export function NativeApplyForm({
  token,
  representativeName,
}: {
  token: string
  representativeName: string
}) {
  const [error, setError] = React.useState<string>()
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    setBusy(true)
    setError(undefined)
    try {
      const response = await fetch(`/api/public/apply/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          legalName: data.get("legalName"),
          dbaName: data.get("dbaName"),
          ein: data.get("ein"),
          entityType: data.get("entityType") || undefined,
          contactName: data.get("contactName"),
          contactEmail: data.get("contactEmail"),
          contactPhone: data.get("contactPhone"),
          industry: data.get("industry"),
          monthlyRevenue: data.get("monthlyRevenue") ? Number(data.get("monthlyRevenue")) : undefined,
          requestedAmount: data.get("requestedAmount") ? Number(data.get("requestedAmount")) : undefined,
          fundingPurpose: data.get("fundingPurpose"),
          startDate: data.get("startDate") || undefined,
          address: {
            line1: data.get("line1"),
            city: data.get("city"),
            state: data.get("state"),
            postalCode: data.get("postalCode"),
            country: "US",
          },
          owners: [
            {
              firstName: data.get("ownerFirst"),
              lastName: data.get("ownerLast"),
              ownershipPercent: data.get("ownershipPercent") ? Number(data.get("ownershipPercent")) : undefined,
              identityLast4: data.get("identityLast4"),
              isPrimary: true,
            },
          ],
        }),
      })
      const payload = await response.json().catch(() => ({})) as { dealId?: string; error?: { message?: string } }
      if (!response.ok || !payload.dealId) {
        throw new RequestError(response.status, payload.error?.message ?? "Could not submit the application.")
      }
      for (const category of CATEGORIES) {
        const file = data.get(category.key)
        if (!(file instanceof File) || !file.size) continue
        const upload = new FormData()
        upload.set("file", file)
        upload.set("dealId", payload.dealId)
        upload.set("category", category.key)
        upload.set("idempotencyKey", `${payload.dealId}:${category.key}:${file.name}:${file.size}`)
        const uploaded = await fetch(`/api/public/apply/${encodeURIComponent(token)}/documents`, { method: "POST", body: upload })
        if (!uploaded.ok) {
          const body = await uploaded.json().catch(() => ({})) as { error?: { message?: string } }
          throw new RequestError(uploaded.status, body.error?.message ?? `Could not upload ${category.label.toLowerCase()}.`)
        }
      }
      setDone(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not submit the application.")
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="rounded-xl border bg-card p-6">
        <div className="flex items-center gap-2 font-medium"><ShieldCheck className="size-5 text-emerald-600" />Application received</div>
        <p className="mt-2 text-sm text-muted-foreground">
          {representativeName} will review your details and documents. You can close this page.
        </p>
      </div>
    )
  }

  return (
    <form className="space-y-6 rounded-xl border bg-card p-6" onSubmit={(event) => void onSubmit(event)}>
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-primary p-2.5 text-primary-foreground"><FileCheck2 className="size-5" /></div>
        <div>
          <h2 className="text-lg font-semibold">Business details</h2>
          <p className="text-sm text-muted-foreground">Assigned to {representativeName}. Upload documents below so they can submit faster.</p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="legalName" label="Legal business name" required />
        <Field name="dbaName" label="DBA (optional)" />
        <Field name="ein" label="EIN" />
        <label className="grid gap-1 text-sm">
          <span>Entity type</span>
          <select name="entityType" className="h-9 rounded-md border bg-background px-2">
            <option value="">Select</option>
            <option value="llc">LLC</option>
            <option value="corporation">Corporation</option>
            <option value="s_corporation">S corporation</option>
            <option value="partnership">Partnership</option>
            <option value="sole_proprietor">Sole proprietor</option>
          </select>
        </label>
        <Field name="contactName" label="Contact name" />
        <Field name="contactEmail" label="Contact email" type="email" />
        <Field name="contactPhone" label="Contact phone" />
        <Field name="industry" label="Industry" />
        <Field name="monthlyRevenue" label="Monthly revenue ($)" type="number" />
        <Field name="requestedAmount" label="Amount requested ($)" type="number" />
        <Field name="fundingPurpose" label="Use of funds" />
        <Field name="startDate" label="Business start date" type="date" />
        <Field name="line1" label="Address" />
        <Field name="city" label="City" />
        <Field name="state" label="State" />
        <Field name="postalCode" label="ZIP" />
        <Field name="ownerFirst" label="Owner first name" />
        <Field name="ownerLast" label="Owner last name" />
        <Field name="ownershipPercent" label="Ownership %" type="number" />
        <Field name="identityLast4" label="Owner ID last four" maxLength={4} />
      </div>
      <div className="grid gap-4">
        <p className="text-sm font-medium">Documents</p>
        {CATEGORIES.map((category) => (
          <label key={category.key} className="grid gap-1 text-sm">
            <span>{category.label}</span>
            <Input name={category.key} type="file" accept={category.accept} />
          </label>
        ))}
      </div>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      <Button type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit application"}</Button>
    </form>
  )
}

function Field({
  name,
  label,
  type = "text",
  required,
  maxLength,
}: {
  name: string
  label: string
  type?: string
  required?: boolean
  maxLength?: number
}) {
  return (
    <label className="grid gap-1 text-sm">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} required={required} maxLength={maxLength} />
    </label>
  )
}
