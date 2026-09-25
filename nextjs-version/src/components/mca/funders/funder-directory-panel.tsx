"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Landmark, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { RequestError, requestJson } from "@/lib/mca/client"
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "@/lib/mca/documents/contracts"
import { FUNDER_ROUTE_KINDS, type FunderContact, type FunderGroup, type FunderRecord, type FunderRoute, type FunderRouteKind } from "@/lib/mca/funders/contracts"
import { FUNDER_FIELD_LIMITS, firstFieldError, remapIndexedFieldErrors, validateFunderProfile, validateGroupName } from "@/lib/mca/funders/validation"
import { CriteriaPanel } from "@/components/mca/funders/criteria-panel"
import { CriteriaScanPanel } from "@/components/mca/funders/criteria-scan-panel"
import { SandboxFunderCard } from "@/components/mca/funders/sandbox-funder-card"
import { isSandboxFunder } from "@/lib/mca/sandbox/labels"
import type { SessionResponse } from "@/lib/mca/types"

const routeLabels: Record<FunderRouteKind, string> = {
  email: "Email",
  api: "API",
  manual_portal: "Manual portal",
  custom_webhook: "Custom webhook",
}

const destinationLabels: Record<FunderRouteKind, string> = {
  email: "Submission email address",
  api: "API integration identifier",
  manual_portal: "Portal URL",
  custom_webhook: "Webhook URL",
}

const documentLabels: Record<DocumentCategory, string> = {
  statement: "Bank statement",
  application: "Application",
  api_application: "Generated application",
  driver_license: "Driver license",
  voided_check: "Voided check",
  closing_document: "Closing document",
  other_stip: "Other stipulation",
}

type ContactDraft = { key: string; name: string; email: string; phone: string; role: string }
type RouteDraft = { key: string; kind: FunderRouteKind; label: string; destination: string; documentExceptions: string[]; active: boolean }
type FunderDraft = {
  legalName: string
  nickname: string
  website: string
  domains: string
  products: string
  active: boolean
  contacts: ContactDraft[]
  routes: RouteDraft[]
}

const emptyFunder = (): FunderDraft => ({
  legalName: "", nickname: "", website: "", domains: "", products: "", active: true,
  contacts: [], routes: [],
})

function contactDraft(contact?: FunderContact): ContactDraft {
  return { key: contact?.id ?? crypto.randomUUID(), name: contact?.name ?? "", email: contact?.email ?? "", phone: contact?.phone ?? "", role: contact?.role ?? "" }
}

function routeDraft(route?: FunderRoute): RouteDraft {
  return {
    key: route?.id ?? crypto.randomUUID(),
    kind: route?.kind ?? "email",
    label: route?.label ?? "",
    destination: route?.destination ?? "",
    documentExceptions: [...(route?.documentExceptions ?? [])],
    active: route?.active ?? true,
  }
}

function fromFunder(funder: FunderRecord): FunderDraft {
  return {
    legalName: funder.legalName,
    nickname: funder.nickname ?? "",
    website: funder.website ?? "",
    domains: funder.domains.join(", "),
    products: funder.products.join(", "),
    active: funder.active,
    contacts: funder.contacts.map(contactDraft),
    routes: funder.routes.map(routeDraft),
  }
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean)
}

function payloadFromDraft(draft: FunderDraft, idempotencyKey?: string) {
  return {
    ...(idempotencyKey ? { idempotencyKey } : {}),
    legalName: draft.legalName,
    nickname: draft.nickname,
    website: draft.website,
    domains: splitList(draft.domains),
    products: splitList(draft.products),
    active: draft.active,
    contacts: draft.contacts.map((contact) => ({ name: contact.name, email: contact.email, phone: contact.phone, role: contact.role })),
    routes: draft.routes.map((route) => ({
      kind: route.kind, label: route.label, destination: route.destination,
      documentExceptions: route.documentExceptions, active: route.active,
    })),
  }
}

export function FunderDirectoryPanel() {
  const [funders, setFunders] = React.useState<FunderRecord[]>([])
  const [groups, setGroups] = React.useState<FunderGroup[]>([])
  const [resolved, setResolved] = React.useState<Record<string, string[]>>({})
  const [canManage, setCanManage] = React.useState(false)
  const [includeInactive, setIncludeInactive] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({})
  const [selectedId, setSelectedId] = React.useState<string>()
  const [draft, setDraft] = React.useState<FunderDraft>(emptyFunder)
  const [groupName, setGroupName] = React.useState("")
  const [groupFunderIds, setGroupFunderIds] = React.useState<string[]>([])
  const [editingGroupId, setEditingGroupId] = React.useState<string>()
  const [section, setSection] = React.useState("directory")

  const visibleFunders = includeInactive ? funders : funders.filter((item) => item.active)
  const selected = funders.find((item) => item.id === selectedId)
  const selectedNames = Object.fromEntries(funders.map((item) => [item.id, item.legalName]))

  const load = React.useCallback(async (options?: { keepSelection?: boolean }) => {
    if (!options?.keepSelection) setLoading(true)
    setError("")
    try {
      const [directory, groupList, session] = await Promise.all([
        requestJson<{ funders: FunderRecord[] }>("/api/mca/funders?includeInactive=true"),
        requestJson<{ groups: FunderGroup[] }>("/api/mca/funders/groups"),
        requestJson<SessionResponse>("/api/auth/session"),
      ])
      setFunders(directory.funders)
      setGroups(groupList.groups)
      setCanManage(Boolean(session.permissions?.canManageWorkspace))
      const destinations = await Promise.all(groupList.groups.map(async (group) => {
        const detail = await requestJson<{ resolvedFunderIds: string[] }>(`/api/mca/funders/groups/${group.id}`)
        return [group.id, detail.resolvedFunderIds] as const
      }))
      setResolved(Object.fromEntries(destinations))
      if (!options?.keepSelection) {
        setSelectedId(undefined)
        setDraft(emptyFunder())
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The funder directory could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  function fail(caught: unknown, fallback: string) {
    if (caught instanceof RequestError) {
      setError(caught.message)
      setFieldErrors(caught.fieldErrors ?? {})
      return
    }
    setError(caught instanceof Error ? caught.message : fallback)
    setFieldErrors({})
  }

  async function saveFunder(event: React.FormEvent) {
    event.preventDefault()
    if (!canManage) return
    const nextErrors = validateFunderProfile(payloadFromDraft(draft), { requireLegalName: true })
    if (Object.keys(nextErrors).length) {
      setFieldErrors(nextErrors)
      setError("Review the highlighted fields.")
      return
    }
    setBusy(true); setError(""); setNotice(""); setFieldErrors({})
    try {
      if (selectedId) {
        const updated = await requestJson<FunderRecord>(`/api/mca/funders/${selectedId}`, { method: "PATCH", body: JSON.stringify(payloadFromDraft(draft)) })
        setNotice(`${updated.legalName} was updated.`)
        toast.success("Funder profile saved")
      } else {
        const created = await requestJson<FunderRecord>("/api/mca/funders", {
          method: "POST",
          body: JSON.stringify(payloadFromDraft(draft, crypto.randomUUID())),
        })
        setSelectedId(created.id)
        setDraft(fromFunder(created))
        setNotice(`${created.legalName} was added to the directory.`)
        toast.success("Funder created")
      }
      await load({ keepSelection: true })
    } catch (caught) {
      fail(caught, "The funder profile could not be saved.")
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(funder: FunderRecord, active: boolean) {
    if (!canManage) return
    setBusy(true); setError(""); setNotice("")
    try {
      const updated = await requestJson<FunderRecord>(`/api/mca/funders/${funder.id}`, { method: "PATCH", body: JSON.stringify({ active }) })
      setNotice(active ? `${updated.legalName} is active again.` : `${updated.legalName} was marked inactive and remains available for history.`)
      if (selectedId === funder.id) setDraft((current) => ({ ...current, active }))
      await load({ keepSelection: true })
    } catch (caught) {
      fail(caught, "The funder could not be updated.")
    } finally {
      setBusy(false)
    }
  }

  async function saveGroup(event: React.FormEvent) {
    event.preventDefault()
    if (!canManage) return
    const nextErrors = validateGroupName(groupName, { required: true })
    if (Object.keys(nextErrors).length) {
      setFieldErrors(nextErrors)
      setError("Review the highlighted fields.")
      return
    }
    setBusy(true); setError(""); setNotice(""); setFieldErrors({})
    try {
      if (editingGroupId) {
        await requestJson(`/api/mca/funders/groups/${editingGroupId}`, { method: "PATCH", body: JSON.stringify({ name: groupName, funderIds: groupFunderIds }) })
        setNotice("Funder group updated.")
      } else {
        await requestJson("/api/mca/funders/groups", { method: "POST", body: JSON.stringify({ name: groupName, funderIds: groupFunderIds }) })
        setNotice("Funder group created.")
      }
      setGroupName(""); setGroupFunderIds([]); setEditingGroupId(undefined)
      toast.success("Group saved")
      await load({ keepSelection: true })
    } catch (caught) {
      fail(caught, "The funder group could not be saved.")
    } finally {
      setBusy(false)
    }
  }

  function editFunder(funder: FunderRecord) {
    setSelectedId(funder.id)
    setDraft(fromFunder(funder))
    setFieldErrors({})
    setNotice("")
  }

  function startCreate() {
    setSelectedId(undefined)
    setDraft(emptyFunder())
    setFieldErrors({})
    setNotice("")
  }

  function toggleGroupFunder(id: string, checked: boolean) {
    setGroupFunderIds((current) => checked ? [...current, id] : current.filter((item) => item !== id))
  }

  function setDocumentException(routeKey: string, category: string, checked: boolean) {
    setDraft((current) => ({
      ...current,
      routes: current.routes.map((route) => route.key === routeKey ? {
        ...route,
        documentExceptions: [
          ...route.documentExceptions.filter((item) => item.toLowerCase() !== category.toLowerCase()),
          ...(checked ? [category] : []),
        ],
      } : route),
    }))
  }

  if (loading) {
    return <Card><CardContent className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />Loading funders…</CardContent></Card>
  }

  if (error && !funders.length && !groups.length) {
    return <Card><CardContent className="flex min-h-40 items-center gap-3 p-6"><AlertCircle className="size-5 text-destructive" /><div className="flex-1"><p className="font-medium">Funder directory unavailable</p><p className="text-sm text-muted-foreground">{error}</p></div><Button variant="outline" onClick={() => void load()}><RefreshCw />Retry</Button></CardContent></Card>
  }

  return <div className="space-y-4">
    <SandboxFunderCard canManage={canManage} onChange={() => void load({ keepSelection: true })} />
    {(error || notice) && <div className={`rounded-lg border p-4 text-sm ${error ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-emerald-500/30 bg-emerald-500/5"}`} role={error ? "alert" : "status"}>
      <div className="flex items-start gap-2">{error ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}<p>{error || notice}</p></div>
    </div>}

    <Tabs value={section} onValueChange={setSection}>
      <TabsList><TabsTrigger value="directory">Directory</TabsTrigger><TabsTrigger value="groups">Groups</TabsTrigger></TabsList>
      <TabsContent value="directory" className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_1fr]">
        <Card>
          <CardHeader className="space-y-3">
            <CardTitle className="flex items-center gap-2"><Landmark className="size-5" />Funders</CardTitle>
            <CardDescription>Workspace profiles used for targeting, routing, and history.</CardDescription>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="include-inactive" className="text-sm font-normal">Show inactive</Label>
              <Switch id="include-inactive" checked={includeInactive} onCheckedChange={setIncludeInactive} />
            </div>
            {canManage && <Button type="button" variant="outline" onClick={startCreate}><Plus />New funder</Button>}
          </CardHeader>
          <CardContent>
            {!visibleFunders.length ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="mca-funders-empty">{funders.length ? "No active funders. Turn on Show inactive to review archived profiles." : <div className="space-y-3"><p>No funders yet. Add the first funder profile to start routing submissions.</p>{canManage ? <Button type="button" onClick={startCreate}><Plus />Add your first funder</Button> : null}</div>}</div> : <div className="space-y-2">
              {visibleFunders.map((funder) => <button key={funder.id} type="button" onClick={() => editFunder(funder)} className={`flex w-full items-start justify-between gap-2 rounded-lg border p-3 text-left text-sm ${selectedId === funder.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"} ${isSandboxFunder(funder) ? "border-amber-500/50" : ""}`}>
                <span><span className="font-medium">{funder.legalName}</span>{funder.nickname ? <span className="block text-xs text-muted-foreground">{funder.nickname}</span> : null}</span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  {isSandboxFunder(funder) ? <Badge variant="outline" className="border-amber-600 text-amber-800">SANDBOX</Badge> : null}
                  <Badge variant={funder.active ? "secondary" : "outline"}>{funder.active ? "Active" : "Inactive"}</Badge>
                </span>
              </button>)}
            </div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{selectedId ? "Edit funder" : "Create funder"}</CardTitle>
            <CardDescription>Legal name is required. Inactive funders stay readable for history and cannot be selected for new targeting.</CardDescription>
          </CardHeader>
          <CardContent>
            <form noValidate onSubmit={(event) => void saveFunder(event)} className="space-y-5">
              {selected && isSandboxFunder(selected) ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                  This profile is the workspace sandbox funder — not a real lender. Identity and route stay locked so it cannot be mistaken for a live destination.
                </div>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Legal name" htmlFor="legal-name" error={fieldErrors.legalName?.[0]} required>
                  <Input id="legal-name" value={draft.legalName} disabled={!canManage || Boolean(selected && isSandboxFunder(selected))} onChange={(event) => setDraft({ ...draft, legalName: event.target.value })} aria-required aria-invalid={Boolean(fieldErrors.legalName?.[0])} />
                </Field>
                <Field label="Nickname" htmlFor="nickname" error={fieldErrors.nickname?.[0]}>
                  <Input id="nickname" value={draft.nickname} disabled={!canManage || Boolean(selected && isSandboxFunder(selected))} onChange={(event) => setDraft({ ...draft, nickname: event.target.value })} aria-invalid={Boolean(fieldErrors.nickname?.[0])} />
                </Field>
                <Field label="Website" htmlFor="website" error={fieldErrors.website?.[0]}>
                  <Input id="website" value={draft.website} disabled={!canManage} onChange={(event) => setDraft({ ...draft, website: event.target.value })} placeholder="https://funder.example" aria-invalid={Boolean(fieldErrors.website?.[0])} />
                </Field>
                <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <div><Label htmlFor="funder-active">Active</Label><p className="text-xs text-muted-foreground">Turn off to archive without deleting.</p></div>
                  <Switch id="funder-active" checked={draft.active} disabled={!canManage} onCheckedChange={(active) => setDraft({ ...draft, active })} />
                </div>
                <Field label="Domains" htmlFor="domains" error={firstFieldError(fieldErrors, "domains")} className="sm:col-span-2">
                  <Input id="domains" value={draft.domains} disabled={!canManage || Boolean(selected && isSandboxFunder(selected))} onChange={(event) => setDraft({ ...draft, domains: event.target.value })} placeholder="funder.com, iso.funder.com" aria-invalid={Boolean(firstFieldError(fieldErrors, "domains"))} />
                </Field>
                <Field label="Products" htmlFor="products" error={firstFieldError(fieldErrors, "products")} className="sm:col-span-2">
                  <Input id="products" value={draft.products} disabled={!canManage} onChange={(event) => setDraft({ ...draft, products: event.target.value })} placeholder="MCA, ACH" aria-invalid={Boolean(firstFieldError(fieldErrors, "products"))} />
                </Field>
              </div>

              <section className="space-y-3">
                <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Contacts</h3>{canManage && <Button type="button" variant="outline" size="sm" onClick={() => setDraft({ ...draft, contacts: [...draft.contacts, contactDraft()] })}><Plus />Contact</Button>}</div>
                {fieldErrors.contacts?.[0] && <p id="contacts-error" role="alert" className="text-xs text-destructive">{fieldErrors.contacts[0]}</p>}
                {!draft.contacts.length ? <p className="text-sm text-muted-foreground">No contacts yet.</p> : draft.contacts.map((contact, index) => {
                  const nameError = fieldErrors[`contacts.${index}.name`]?.[0]
                  const emailError = fieldErrors[`contacts.${index}.email`]?.[0]
                  const roleError = fieldErrors[`contacts.${index}.role`]?.[0]
                  const nameErrorId = `contact-${contact.key}-name-error`
                  const emailErrorId = `contact-${contact.key}-email-error`
                  const roleErrorId = `contact-${contact.key}-role-error`
                  return <div key={contact.key} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <div className="space-y-1">
                    <Input aria-label={`Contact ${index + 1} name`} placeholder="Name" value={contact.name} disabled={!canManage} onChange={(event) => setDraft({ ...draft, contacts: draft.contacts.map((item) => item.key === contact.key ? { ...item, name: event.target.value } : item) })} aria-invalid={Boolean(nameError)} aria-describedby={nameError ? nameErrorId : undefined} />
                    {nameError && <p id={nameErrorId} role="alert" className="text-xs text-destructive">{nameError}</p>}
                  </div>
                  <div className="space-y-1">
                    <Input aria-label={`Contact ${index + 1} email`} placeholder="Email" value={contact.email} disabled={!canManage} onChange={(event) => setDraft({ ...draft, contacts: draft.contacts.map((item) => item.key === contact.key ? { ...item, email: event.target.value } : item) })} aria-invalid={Boolean(emailError)} aria-describedby={emailError ? emailErrorId : undefined} />
                    {emailError && <p id={emailErrorId} role="alert" className="text-xs text-destructive">{emailError}</p>}
                  </div>
                  <div className="space-y-1">
                    <Input aria-label={`Contact ${index + 1} role`} placeholder="Role" value={contact.role} disabled={!canManage} onChange={(event) => setDraft({ ...draft, contacts: draft.contacts.map((item) => item.key === contact.key ? { ...item, role: event.target.value } : item) })} aria-invalid={Boolean(roleError)} aria-describedby={roleError ? roleErrorId : undefined} />
                    {roleError && <p id={roleErrorId} role="alert" className="text-xs text-destructive">{roleError}</p>}
                  </div>
                  {canManage && <Button type="button" variant="ghost" size="icon" aria-label={`Remove contact ${index + 1}`} onClick={() => {
                    const contacts = draft.contacts.filter((item) => item.key !== contact.key)
                    setDraft({ ...draft, contacts })
                    setFieldErrors((current) => remapIndexedFieldErrors(current, "contacts", index, contacts.length, FUNDER_FIELD_LIMITS.maxContacts))
                  }}><Trash2 /></Button>}
                </div>
                })}
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Routes</h3>{canManage && <Button type="button" variant="outline" size="sm" onClick={() => setDraft({ ...draft, routes: [...draft.routes, routeDraft()] })}><Plus />Route</Button>}</div>
                {fieldErrors.routes?.[0] && <p id="routes-error" role="alert" className="text-xs text-destructive">{fieldErrors.routes[0]}</p>}
                {!draft.routes.length ? <p className="text-sm text-muted-foreground">No submission routes yet.</p> : draft.routes.map((route, index) => {
                  const kindError = fieldErrors[`routes.${index}.kind`]?.[0]
                  const labelError = fieldErrors[`routes.${index}.label`]?.[0]
                  const kindErrorId = `route-${route.key}-kind-error`
                  const labelErrorId = `route-${route.key}-label-error`
                  const exceptionsError = fieldErrors[`routes.${index}.documentExceptions`]?.[0]
                  const exceptionsErrorId = `route-${route.key}-exceptions-error`
                  return <div key={route.key} className="space-y-2 rounded-lg border p-3">
                  <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
                    <div className="space-y-1">
                      <Select value={route.kind} disabled={!canManage || Boolean(selected && isSandboxFunder(selected))} onValueChange={(kind) => setDraft({ ...draft, routes: draft.routes.map((item) => item.key === route.key ? { ...item, kind: kind as FunderRouteKind } : item) })}>
                        <SelectTrigger aria-label={`Route ${index + 1} kind`} aria-invalid={Boolean(kindError)} aria-describedby={kindError ? kindErrorId : undefined}><SelectValue /></SelectTrigger>
                        <SelectContent>{FUNDER_ROUTE_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{routeLabels[kind]}</SelectItem>)}</SelectContent>
                      </Select>
                      {kindError && <p id={kindErrorId} role="alert" className="text-xs text-destructive">{kindError}</p>}
                    </div>
                    <div className="space-y-1">
                      <Input aria-label={`Route ${index + 1} label`} placeholder="Label" value={route.label} disabled={!canManage} onChange={(event) => setDraft({ ...draft, routes: draft.routes.map((item) => item.key === route.key ? { ...item, label: event.target.value } : item) })} aria-invalid={Boolean(labelError)} aria-describedby={labelError ? labelErrorId : undefined} />
                      {labelError && <p id={labelErrorId} role="alert" className="text-xs text-destructive">{labelError}</p>}
                    </div>
                    {canManage && <Button type="button" variant="ghost" size="icon" aria-label={`Remove route ${index + 1}`} onClick={() => {
                      const routes = draft.routes.filter((item) => item.key !== route.key)
                      setDraft({ ...draft, routes })
                      setFieldErrors((current) => remapIndexedFieldErrors(current, "routes", index, routes.length, FUNDER_FIELD_LIMITS.maxRoutes))
                    }}><Trash2 /></Button>}
                  </div>
                  <Field label={destinationLabels[route.kind]} htmlFor={`route-destination-${route.key}`} error={fieldErrors[`routes.${index}.destination`]?.[0]}>
                    <Input id={`route-destination-${route.key}`} value={route.destination} disabled={!canManage || Boolean(selected && isSandboxFunder(selected))} onChange={(event) => setDraft({ ...draft, routes: draft.routes.map((item) => item.key === route.key ? { ...item, destination: event.target.value } : item) })} aria-invalid={Boolean(fieldErrors[`routes.${index}.destination`]?.[0])} />
                  </Field>
                  <details className="rounded-md border p-3">
                    <summary className="cursor-pointer text-sm font-medium">Documents not to send (optional){route.documentExceptions.length ? ` · ${route.documentExceptions.length} selected` : ""}</summary>
                    <p className="mt-2 text-xs text-muted-foreground">Selected document types will be left out of submissions through this route.</p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      {DOCUMENT_CATEGORIES.map((category) => <div key={category} className="flex items-center gap-2">
                        <Checkbox id={`route-${route.key}-${category}`} checked={route.documentExceptions.some((item) => item.toLowerCase() === category)} disabled={!canManage} onCheckedChange={(checked) => setDocumentException(route.key, category, checked === true)} />
                        <Label htmlFor={`route-${route.key}-${category}`} className="font-normal">{documentLabels[category]}</Label>
                      </div>)}
                      {route.documentExceptions.filter((item) => !DOCUMENT_CATEGORIES.some((category) => category === item.toLowerCase())).map((item) => <div key={item} className="flex items-center gap-2">
                        <Checkbox id={`route-${route.key}-${item}`} checked disabled={!canManage} onCheckedChange={(checked) => setDocumentException(route.key, item, checked === true)} />
                        <Label htmlFor={`route-${route.key}-${item}`} className="font-normal">Saved exclusion: {item}</Label>
                      </div>)}
                    </div>
                    {exceptionsError && <p id={exceptionsErrorId} role="alert" className="mt-2 text-xs text-destructive">{exceptionsError}</p>}
                  </details>
                  <div className="flex items-center justify-between"><Label htmlFor={`route-active-${route.key}`}>Route active</Label><Switch id={`route-active-${route.key}`} checked={route.active} disabled={!canManage} onCheckedChange={(active) => setDraft({ ...draft, routes: draft.routes.map((item) => item.key === route.key ? { ...item, active } : item) })} /></div>
                </div>
                })}
              </section>

              {canManage ? <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : null}{selectedId ? "Save funder" : "Create funder"}</Button>
                {selected && <Button type="button" variant="outline" disabled={busy} onClick={() => void toggleActive(selected, !selected.active)}>{selected.active ? "Mark inactive" : "Reactivate"}</Button>}
              </div> : <p className="text-sm text-muted-foreground">Only workspace admins can create or edit funder profiles.</p>}
            </form>
            {selectedId ? <div className="mt-6 space-y-6"><CriteriaPanel funderId={selectedId} /><CriteriaScanPanel funderId={selectedId} /></div> : null}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="groups" className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Named groups</CardTitle>
            <CardDescription>Reusable destination lists. Resolution keeps unique active funders only.</CardDescription>
          </CardHeader>
          <CardContent>
            {!groups.length ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No groups yet. Create a named list of funders for repeated targeting.</div> : <div className="space-y-2">
              {groups.map((group) => <button key={group.id} type="button" className={`w-full rounded-lg border p-3 text-left text-sm ${editingGroupId === group.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`} onClick={() => { setEditingGroupId(group.id); setGroupName(group.name); setGroupFunderIds(group.funderIds) }}>
                <span className="font-medium">{group.name}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{(resolved[group.id] ?? []).length} active destination{(resolved[group.id] ?? []).length === 1 ? "" : "s"}</span>
              </button>)}
            </div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{editingGroupId ? "Edit group" : "Create group"}</CardTitle>
            <CardDescription>Duplicate and inactive members are stored, then dropped when the group is resolved.</CardDescription>
          </CardHeader>
          <CardContent>
            <form noValidate onSubmit={(event) => void saveGroup(event)} className="space-y-4">
              <Field label="Group name" htmlFor="group-name" error={fieldErrors.name?.[0]} required>
                <Input id="group-name" value={groupName} disabled={!canManage} onChange={(event) => setGroupName(event.target.value)} aria-required aria-invalid={Boolean(fieldErrors.name?.[0])} />
              </Field>
              <div className="space-y-2">
                <Label>Funders</Label>
                {!funders.length ? <p className="text-sm text-muted-foreground">Create funders before adding them to a group.</p> : <div className="max-h-72 space-y-2 overflow-auto rounded-lg border p-3">
                  {funders.map((funder) => <label key={funder.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={groupFunderIds.includes(funder.id)} disabled={!canManage} onCheckedChange={(checked) => toggleGroupFunder(funder.id, checked === true)} />
                    <span className="flex-1">{funder.legalName}</span>
                    {!funder.active && <Badge variant="outline">Inactive</Badge>}
                  </label>)}
                </div>}
              </div>
              {editingGroupId && <div className="rounded-lg bg-muted p-3 text-sm">
                <p className="font-medium">Resolved destinations</p>
                <p className="mt-1 text-muted-foreground">{(resolved[editingGroupId] ?? []).map((id) => selectedNames[id] ?? id).join(", ") || "None — inactive and duplicate members are omitted."}</p>
              </div>}
              {canManage ? <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : null}{editingGroupId ? "Save group" : "Create group"}</Button>
                {editingGroupId && <Button type="button" variant="outline" onClick={() => { setEditingGroupId(undefined); setGroupName(""); setGroupFunderIds([]) }}>New group</Button>}
              </div> : <p className="text-sm text-muted-foreground">Only workspace admins can create or edit groups.</p>}
            </form>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  </div>
}

function Field({
  label,
  htmlFor,
  error,
  className,
  required,
  children,
}: {
  label: string
  htmlFor: string
  error?: string
  className?: string
  required?: boolean
  children: React.ReactElement<{
    id?: string
    "aria-invalid"?: boolean
    "aria-describedby"?: string
    "aria-required"?: boolean
  }>
}) {
  const errorId = `${htmlFor}-error`
  return <div className={`space-y-2 ${className ?? ""}`}>
    <Label htmlFor={htmlFor}>{label}{required ? <span className="sr-only"> (required)</span> : null}</Label>
    {React.cloneElement(children, {
      id: children.props.id ?? htmlFor,
      "aria-invalid": Boolean(error) || children.props["aria-invalid"],
      "aria-describedby": error ? errorId : children.props["aria-describedby"],
      "aria-required": required || children.props["aria-required"],
    })}
    {error && <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>}
  </div>
}
