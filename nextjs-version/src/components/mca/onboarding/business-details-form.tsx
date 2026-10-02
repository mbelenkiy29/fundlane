"use client"
import * as React from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestJson, RequestError } from "@/lib/mca/client"
import type { BusinessBasics } from "@/lib/mca/onboarding/business-profile"

export function BusinessDetailsForm({ initialBasics }: { initialBasics?: BusinessBasics }) {
  const [basics, setBasics] = React.useState(initialBasics)
  const [legalName, setLegalName] = React.useState(initialBasics?.legalName ?? "")
  const [ein, setEin] = React.useState("")
  const [replace, setReplace] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [fields, setFields] = React.useState<Record<string, string[]>>({})
  const nameRef = React.useRef<HTMLInputElement>(null), einRef = React.useRef<HTMLInputElement>(null)
  const load = React.useCallback(async () => {
    const value = await requestJson<BusinessBasics>("/api/mca/onboarding/business")
    setBasics(value); setLegalName(value.legalName); setEin(""); setReplace(false)
  }, [])
  React.useEffect(() => { if (!initialBasics) void load().catch(() => setError("Business details could not be loaded. Sign in and check your workspace access.")) }, [initialBasics, load])
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice(""); setFields({})
    try {
      const value = await requestJson<{ legalName: string; einPresent: true; revision: number }>("/api/mca/onboarding/business", { method: "POST", body: JSON.stringify({ legalName, ein, expectedRevision: basics?.revision ?? 0 }) })
      setBasics({ ...value, registered: false }); setLegalName(value.legalName); setReplace(false); setNotice("Business details supplied securely. You can continue using the CRM.")
    } catch (caught) {
      if (caught instanceof RequestError) { setError(caught.message); setFields(caught.fieldErrors ?? {}); if (caught.fieldErrors?.legalName) nameRef.current?.focus(); else einRef.current?.focus() }
      else setError("Business details could not be saved. Re-enter the EIN and try again.")
    } finally { setEin(""); setBusy(false) }
  }
  if (!basics) return <p role="status">{error || "Loading business details…"}</p>
  const needsEin = !basics.einPresent || replace
  return <form onSubmit={event => void save(event)} className="max-w-xl space-y-5" autoComplete="off">
    <div><h2 className="text-xl font-semibold">Business details</h2><p className="text-sm text-muted-foreground">Optional setup for your company. Legal name and EIN are encrypted; full phone and SMS registration is a separate step.</p></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="grid gap-2"><Label htmlFor="business-legal-name">Legal business name</Label><Input ref={nameRef} id="business-legal-name" name="legalName" value={legalName} onChange={e => setLegalName(e.target.value)} minLength={2} maxLength={150} required readOnly={basics.registered} aria-invalid={Boolean(fields.legalName)} aria-describedby={fields.legalName ? "business-name-error" : undefined} />{fields.legalName && <p id="business-name-error">{fields.legalName.join(" ")}</p>}</div>
    {basics.einPresent && <p>EIN supplied ••-•••••••</p>}
    {needsEin && !basics.registered && <div className="grid gap-2"><Label htmlFor="business-ein">EIN</Label><Input ref={einRef} id="business-ein" name="ein" type="password" inputMode="numeric" autoComplete="off" value={ein} onChange={e => setEin(e.target.value)} pattern="[0-9]{2}-?[0-9]{7}" maxLength={10} required aria-invalid={Boolean(fields.ein)} aria-describedby="business-ein-help" /><p id="business-ein-help">Nine digits, with an optional hyphen after the first two. {fields.ein?.join(" ")}</p></div>}
    {basics.registered ? <p>Your existing approved or registered business identity is preserved. Contact the platform operator to request a correction.</p> : <div className="flex flex-wrap gap-3">{basics.einPresent && !replace && <Button type="button" variant="outline" onClick={() => setReplace(true)}>Replace EIN</Button>}<Button type="submit" disabled={busy || !needsEin}>{busy ? "Saving…" : "Save business details"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void load().catch(() => setError("Unable to reload business details."))}>Reload details</Button></div>}
    <div className="flex gap-4 text-sm"><Link href="/dashboard" className="underline">Continue to CRM</Link><Link href="/getting-started" className="underline">Getting started</Link><Link href="/settings/connections" className="underline">Full SMS registration</Link></div>
  </form>
}
