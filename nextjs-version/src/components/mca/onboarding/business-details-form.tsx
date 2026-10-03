"use client"
import * as React from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestJson, RequestError } from "@/lib/mca/client"
import type { A2pProfile, BusinessBasics } from "@/lib/mca/onboarding/business-profile"

type A2pDraft = Record<Exclude<keyof A2pProfile, "samples">, string> & { samples: string[] }
const emptyA2p: A2pDraft = { businessType: "", street: "", city: "", region: "", postalCode: "", website: "", privacyUrl: "", termsUrl: "", contactFirstName: "", contactLastName: "", contactTitle: "", contactPosition: "", contactEmail: "", contactPhone: "", purpose: "", samples: ["", ""], consentEvidence: "" }
const a2pText: [keyof A2pDraft, string, React.ComponentProps<"input">?][] = [
  ["street", "Street address"], ["city", "City"], ["region", "State (two capital letters)", { pattern: "[A-Z]{2}", maxLength: 2 }], ["postalCode", "ZIP code", { pattern: "\\d{5}(-\\d{4})?" }],
  ["website", "Business website", { type: "url", placeholder: "https://" }], ["privacyUrl", "Privacy policy URL (optional)", { type: "url", placeholder: "https://" }], ["termsUrl", "Terms URL (optional)", { type: "url", placeholder: "https://" }],
  ["contactFirstName", "Authorized contact first name"], ["contactLastName", "Authorized contact last name"], ["contactTitle", "Authorized contact job title"],
  ["contactEmail", "Authorized contact email", { type: "email" }], ["contactPhone", "Authorized contact mobile phone", { type: "tel", placeholder: "+15555550123", pattern: "\\+1\\d{10}" }],
]
const a2pChoices: [keyof A2pDraft, string, string[]][] = [
  ["businessType", "Business type", ["Limited Liability Corporation", "Corporation", "Partnership", "Sole Proprietorship"]],
  ["contactPosition", "Authorized contact position", ["CEO", "CFO", "General_Manager", "VP", "Director", "Other"]],
]
const a2pAreas: [keyof A2pDraft, string][] = [["purpose", "Use-case description (who you text and why)"], ["consentEvidence", "Opt-in method (how customers agree to texts)"]]
function draft(a2p?: A2pProfile): A2pDraft { return a2p ? { ...emptyA2p, ...a2p, samples: [...a2p.samples] } : emptyA2p }
/** All-empty A2P details are omitted, so a basics-only save keeps any stored A2P details. */
function a2pPayload(value: A2pDraft) {
  const samples = value.samples.map(sample => sample.trim()).filter(Boolean)
  const fields = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  if (!samples.length && fields.every(([, field]) => !field.trim())) return undefined
  return Object.fromEntries([...fields.filter(([key, field]) => field.trim() || !["privacyUrl", "termsUrl"].includes(key)), ["samples", samples]])
}

export function BusinessDetailsForm({ initialBasics }: { initialBasics?: BusinessBasics }) {
  const [basics, setBasics] = React.useState(initialBasics)
  const [legalName, setLegalName] = React.useState(initialBasics?.legalName ?? "")
  const [ein, setEin] = React.useState("")
  const [a2p, setA2p] = React.useState(draft(initialBasics?.a2p))
  const [replace, setReplace] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [fields, setFields] = React.useState<Record<string, string[]>>({})
  const nameRef = React.useRef<HTMLInputElement>(null), einRef = React.useRef<HTMLInputElement>(null)
  const load = React.useCallback(async () => {
    const value = await requestJson<BusinessBasics>("/api/mca/onboarding/business")
    setBasics(value); setLegalName(value.legalName); setEin(""); setA2p(draft(value.a2p)); setReplace(false)
  }, [])
  React.useEffect(() => { if (!initialBasics) void load().catch(() => setError("Business details could not be loaded. Sign in and check your workspace access.")) }, [initialBasics, load])
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice(""); setFields({})
    try {
      const details = a2pPayload(a2p), sendEin = !basics?.einPresent || replace
      const value = await requestJson<{ legalName: string; einPresent: true; revision: number }>("/api/mca/onboarding/business", { method: "POST", body: JSON.stringify({ legalName, ...(sendEin ? { ein } : {}), ...(details ? { a2p: details } : {}), expectedRevision: basics?.revision ?? 0 }) })
      setBasics({ ...value, registered: false }); setLegalName(value.legalName); setReplace(false); setNotice("Business details supplied securely. You can continue using the CRM.")
    } catch (caught) {
      if (caught instanceof RequestError) { setError(caught.message); setFields(caught.fieldErrors ?? {}); if (caught.fieldErrors?.legalName) nameRef.current?.focus(); else if (caught.fieldErrors?.ein) einRef.current?.focus() }
      else setError("Business details could not be saved. Re-enter the EIN and try again.")
    } finally { setEin(""); setBusy(false) }
  }
  if (!basics) return <p role="status">{error || "Loading business details…"}</p>
  const needsEin = !basics.einPresent || replace
  const fieldError = (key: string) => fields[`a2p.${key}`] ? { "aria-invalid": true, "aria-describedby": `business-a2p-${key}-error` } : {}
  const errorText = (key: string) => fields[`a2p.${key}`] && <p id={`business-a2p-${key}-error`}>{fields[`a2p.${key}`].join(" ")}</p>
  const set = (key: keyof A2pDraft, value: string) => setA2p(current => ({ ...current, [key]: value }))
  return <form onSubmit={event => void save(event)} className="max-w-xl space-y-5" autoComplete="off">
    <div><h2 className="text-xl font-semibold">Business details</h2><p className="text-sm text-muted-foreground">Optional setup for your company. Legal name and EIN are encrypted; full phone and SMS registration is a separate step.</p></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="grid gap-2"><Label htmlFor="business-legal-name">Legal business name</Label><Input ref={nameRef} id="business-legal-name" name="legalName" value={legalName} onChange={e => setLegalName(e.target.value)} minLength={2} maxLength={150} required readOnly={basics.registered} aria-invalid={Boolean(fields.legalName)} aria-describedby={fields.legalName ? "business-name-error" : undefined} />{fields.legalName && <p id="business-name-error">{fields.legalName.join(" ")}</p>}</div>
    {basics.einPresent && <p>EIN supplied ••-•••••••</p>}
    {needsEin && !basics.registered && <div className="grid gap-2"><Label htmlFor="business-ein">EIN</Label><Input ref={einRef} id="business-ein" name="ein" type="password" inputMode="numeric" autoComplete="off" value={ein} onChange={e => setEin(e.target.value)} pattern="[0-9]{2}-?[0-9]{7}" maxLength={10} required aria-invalid={Boolean(fields.ein)} aria-describedby="business-ein-help" /><p id="business-ein-help">Nine digits, with an optional hyphen after the first two. {fields.ein?.join(" ")}</p></div>}
    {!basics.registered && <fieldset className="space-y-4">
      <legend className="font-semibold">Business texting registration (A2P 10DLC)</legend>
      <p className="text-sm text-muted-foreground">Optional. Fill in every field except the privacy and terms URLs to submit these details for SMS registration. Saving does not verify your business.</p>
      {fields.a2p && <p>{fields.a2p.join(" ")}</p>}
      {a2pChoices.map(([key, label, options]) => <div key={key} className="grid gap-2"><Label htmlFor={`business-a2p-${key}`}>{label}</Label><select className="rounded-md border p-2" id={`business-a2p-${key}`} name={key} value={a2p[key] as string} onChange={e => set(key, e.target.value)} {...fieldError(key)}><option value="">Select…</option>{options.map(option => <option key={option} value={option}>{option.replace("_", " ")}</option>)}</select>{errorText(key)}</div>)}
      {a2pText.map(([key, label, props]) => <div key={key} className="grid gap-2"><Label htmlFor={`business-a2p-${key}`}>{label}</Label><Input id={`business-a2p-${key}`} name={key} value={a2p[key] as string} onChange={e => set(key, e.target.value)} maxLength={300} {...props} {...fieldError(key)} />{errorText(key)}</div>)}
      {a2pAreas.map(([key, label]) => <div key={key} className="grid gap-2"><Label htmlFor={`business-a2p-${key}`}>{label}</Label><textarea className="rounded-md border p-2" id={`business-a2p-${key}`} name={key} value={a2p[key] as string} onChange={e => set(key, e.target.value)} maxLength={3000} {...fieldError(key)} />{errorText(key)}</div>)}
      {a2p.samples.map((sample, index) => <div key={index} className="grid gap-2"><Label htmlFor={`business-a2p-sample-${index}`}>Sample message {index + 1}</Label><textarea className="rounded-md border p-2" id={`business-a2p-sample-${index}`} name={`samples.${index}`} value={sample} onChange={e => setA2p(current => ({ ...current, samples: current.samples.map((value, position) => position === index ? e.target.value : value) }))} maxLength={1000} {...fieldError("samples")} /></div>)}
      {errorText("samples")}
      {a2p.samples.length < 5 && <Button type="button" variant="outline" onClick={() => setA2p(current => ({ ...current, samples: [...current.samples, ""] }))}>Add sample message</Button>}
    </fieldset>}
    {basics.registered ? <p>Your existing approved or registered business identity is preserved. Contact the platform operator to request a correction.</p> : <div className="flex flex-wrap gap-3">{basics.einPresent && !replace && <Button type="button" variant="outline" onClick={() => setReplace(true)}>Replace EIN</Button>}<Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save business details"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void load().catch(() => setError("Unable to reload business details."))}>Reload details</Button></div>}
    <div className="flex gap-4 text-sm"><Link href="/dashboard" className="underline">Continue to CRM</Link><Link href="/getting-started" className="underline">Getting started</Link><Link href="/settings/connections" className="underline">Full SMS registration</Link></div>
  </form>
}
