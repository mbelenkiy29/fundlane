"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, History, Loader2, Mail, MessageSquareText, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RequestError, requestJson } from "@/lib/mca/client"

type Channel = "email" | "sms"
type Scope = "merchant" | "followup" | "digest" | "request_info"
type VariableGroup = "deal" | "business" | "owner" | "rep" | "offers" | "documents" | "uploads"

type TemplateVariable = {
  name: string
  group: VariableGroup
  label: string
  description: string
  example: string
  aliasOf?: string
}

type TemplateListItem = {
  id: string
  name: string
  channel: Channel
  scope: Scope
  published: boolean
  publishedVersionId: string | null
  updatedAt: string
}

type VersionView = {
  id: string
  templateId: string
  version: number
  subject: string | null
  body: string
  variableSchemaHash: string
  published: boolean
  createdAt: string
}

type TemplateView = {
  id: string
  name: string
  channel: Channel
  scope: Scope
  publishedVersionId: string | null
  draft: VersionView | null
  published: VersionView | null
  canManage: boolean
  canPublish: boolean
  updatedAt: string
}

type ListPayload = {
  templates: TemplateListItem[]
  variables: TemplateVariable[]
  canManage: boolean
  canPublish: boolean
}

type PreviewPayload = {
  channel: Channel
  scope: Scope
  dealId?: string
  synthetic: boolean
  subject?: string
  html?: string
  text: string
  unknownVariables: string[]
  forbiddenVariables: string[]
  publishBlocked: boolean
}

type ValidationPayload = {
  names: string[]
  unknown: string[]
  forbidden: string[]
  publishable: boolean
}

export const TEMPLATE_EDITOR_COPY = {
  loading: "Loading message templates…",
  empty: "No message templates yet. Create one to personalize merchant email and SMS.",
  nameRequired: "Enter a template name.",
  bodyRequired: "Enter template text.",
  unknown: "Unknown variables cannot be published.",
  forbidden: "Merchant templates cannot access commission or another deal's data.",
  published: "Template published.",
  saved: "Draft saved.",
  failed: "The template could not be saved.",
  previewFailed: "This template could not be previewed.",
}

const GROUP_LABEL: Record<VariableGroup, string> = {
  deal: "Deal",
  business: "Business",
  owner: "Owner",
  rep: "Rep",
  offers: "Offers",
  documents: "Documents",
  uploads: "Upload links",
}

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof RequestError) {
    const fields = caught.fieldErrors ? Object.values(caught.fieldErrors).flat().filter(Boolean) : []
    if (fields.length) return fields.join(" ")
    return caught.message
  }
  return caught instanceof Error ? caught.message : fallback
}

export function templateEditorGate(input: {
  loading: boolean
  templates: TemplateListItem[]
  name: string
  body: string
  unknownVariables: string[]
  forbiddenVariables: string[]
  canPublish: boolean
}): { phase: "loading" | "empty" | "validation" | "ready"; publishEnabled: boolean; saveEnabled: boolean; reason: string } {
  if (input.loading) return { phase: "loading", publishEnabled: false, saveEnabled: false, reason: TEMPLATE_EDITOR_COPY.loading }
  if (!input.templates.length && !input.name.trim() && !input.body.trim()) {
    return { phase: "empty", publishEnabled: false, saveEnabled: false, reason: TEMPLATE_EDITOR_COPY.empty }
  }
  if (!input.name.trim()) return { phase: "validation", publishEnabled: false, saveEnabled: false, reason: TEMPLATE_EDITOR_COPY.nameRequired }
  if (!input.body.trim()) return { phase: "validation", publishEnabled: false, saveEnabled: false, reason: TEMPLATE_EDITOR_COPY.bodyRequired }
  if (input.forbiddenVariables.length) return { phase: "validation", publishEnabled: false, saveEnabled: true, reason: TEMPLATE_EDITOR_COPY.forbidden }
  if (input.unknownVariables.length) return { phase: "validation", publishEnabled: false, saveEnabled: true, reason: TEMPLATE_EDITOR_COPY.unknown }
  if (!input.canPublish) return { phase: "validation", publishEnabled: false, saveEnabled: false, reason: "Only administrators can publish message templates." }
  return { phase: "ready", publishEnabled: true, saveEnabled: true, reason: "Ready to publish this template." }
}

export function TemplateEditor() {
  const [payload, setPayload] = React.useState<ListPayload>()
  const [selectedId, setSelectedId] = React.useState<string>()
  const [detail, setDetail] = React.useState<TemplateView>()
  const [versions, setVersions] = React.useState<VersionView[]>([])
  const [name, setName] = React.useState("")
  const [channel, setChannel] = React.useState<Channel>("email")
  const [scope, setScope] = React.useState<Scope>("merchant")
  const [subject, setSubject] = React.useState("")
  const [body, setBody] = React.useState("")
  const [dealId, setDealId] = React.useState("")
  const [preview, setPreview] = React.useState<PreviewPayload>()
  const [validation, setValidation] = React.useState<ValidationPayload>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<"save" | "publish" | "preview" | "create">()
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const bodyRef = React.useRef<HTMLTextAreaElement>(null)

  const variables = payload?.variables ?? []
  const unknownVariables = validation?.unknown ?? preview?.unknownVariables ?? []
  const forbiddenVariables = validation?.forbidden ?? preview?.forbiddenVariables ?? []
  const gate = templateEditorGate({
    loading,
    templates: payload?.templates ?? [],
    name,
    body,
    unknownVariables,
    forbiddenVariables,
    canPublish: Boolean(payload?.canPublish),
  })

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<ListPayload>("/api/mca/comms/templates")
      setPayload(next)
    } catch (caught) {
      setError(errorMessage(caught, TEMPLATE_EDITOR_COPY.failed))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  async function openTemplate(id: string) {
    setBusy("save")
    setError(undefined)
    setMessage(undefined)
    try {
      const next = await requestJson<TemplateView>(`/api/mca/comms/templates/${encodeURIComponent(id)}`)
      const history = await requestJson<{ versions: VersionView[] }>(`/api/mca/comms/templates/${encodeURIComponent(id)}/versions`)
      setSelectedId(id)
      setDetail(next)
      setVersions(history.versions)
      setName(next.name)
      setChannel(next.channel)
      setScope(next.scope)
      const current = next.draft ?? next.published
      setSubject(current?.subject ?? "")
      setBody(current?.body ?? "")
      setPreview(undefined)
      setValidation(undefined)
    } catch (caught) {
      setError(errorMessage(caught, TEMPLATE_EDITOR_COPY.failed))
    } finally {
      setBusy(undefined)
    }
  }

  function resetComposer() {
    setSelectedId(undefined)
    setDetail(undefined)
    setVersions([])
    setName("")
    setChannel("email")
    setScope("merchant")
    setSubject("")
    setBody("")
    setPreview(undefined)
    setValidation(undefined)
    setMessage(undefined)
  }

  function insertVariable(variable: string) {
    const token = `{{${variable}}}`
    const field = bodyRef.current
    if (!field) {
      setBody((current) => `${current}${current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : ""}${token}`)
      return
    }
    const start = field.selectionStart ?? body.length
    const end = field.selectionEnd ?? body.length
    const next = `${body.slice(0, start)}${token}${body.slice(end)}`
    setBody(next)
    requestAnimationFrame(() => {
      field.focus()
      const cursor = start + token.length
      field.setSelectionRange(cursor, cursor)
    })
  }

  async function createTemplate() {
    if (!name.trim()) {
      setError(TEMPLATE_EDITOR_COPY.nameRequired)
      return
    }
    setBusy("create")
    setError(undefined)
    setMessage(undefined)
    try {
      const created = await requestJson<TemplateView>("/api/mca/comms/templates", {
        method: "POST",
        body: JSON.stringify({ name, channel, scope, subject: channel === "email" ? subject : null, body }),
      })
      await load()
      await openTemplate(created.id)
      setMessage(TEMPLATE_EDITOR_COPY.saved)
    } catch (caught) {
      setError(errorMessage(caught, TEMPLATE_EDITOR_COPY.failed))
    } finally {
      setBusy(undefined)
    }
  }

  async function saveDraft(): Promise<boolean> {
    if (!selectedId) {
      await createTemplate()
      return false
    }
    if (!name.trim()) {
      setError(TEMPLATE_EDITOR_COPY.nameRequired)
      return false
    }
    if (!body.trim()) {
      setError(TEMPLATE_EDITOR_COPY.bodyRequired)
      return false
    }
    setBusy("save")
    setError(undefined)
    setMessage(undefined)
    try {
      const saved = await requestJson<TemplateView>(`/api/mca/comms/templates/${encodeURIComponent(selectedId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name, subject: channel === "email" ? subject : null, body }),
      })
      setDetail(saved)
      setMessage(TEMPLATE_EDITOR_COPY.saved)
      await load()
      const history = await requestJson<{ versions: VersionView[] }>(`/api/mca/comms/templates/${encodeURIComponent(selectedId)}/versions`)
      setVersions(history.versions)
      return true
    } catch (caught) {
      setError(errorMessage(caught, TEMPLATE_EDITOR_COPY.failed))
      return false
    } finally {
      setBusy(undefined)
    }
  }

  async function publish() {
    if (!selectedId) {
      setError("Save a draft before publishing.")
      return
    }
    if (unknownVariables.length) {
      setError(TEMPLATE_EDITOR_COPY.unknown)
      return
    }
    if (forbiddenVariables.length) {
      setError(TEMPLATE_EDITOR_COPY.forbidden)
      return
    }
    setBusy("publish")
    setError(undefined)
    setMessage(undefined)
    try {
      const saved = await requestJson<TemplateView>(`/api/mca/comms/templates/${encodeURIComponent(selectedId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name, subject: channel === "email" ? subject : null, body }),
      })
      setDetail(saved)
      const published = await requestJson<TemplateView>(`/api/mca/comms/templates/${encodeURIComponent(selectedId)}/publish`, {
        method: "POST",
        body: JSON.stringify({}),
      })
      setDetail(published)
      setMessage(TEMPLATE_EDITOR_COPY.published)
      await load()
      const history = await requestJson<{ versions: VersionView[] }>(`/api/mca/comms/templates/${encodeURIComponent(selectedId)}/versions`)
      setVersions(history.versions)
    } catch (caught) {
      setError(errorMessage(caught, TEMPLATE_EDITOR_COPY.failed))
    } finally {
      setBusy(undefined)
    }
  }

  async function runPreview(synthetic: boolean) {
    if (!body.trim()) {
      setError(TEMPLATE_EDITOR_COPY.bodyRequired)
      return
    }
    setBusy("preview")
    setError(undefined)
    setMessage(undefined)
    try {
      const checked = await requestJson<ValidationPayload>("/api/mca/comms/templates/validate", {
        method: "POST",
        body: JSON.stringify({ subject: channel === "email" ? subject : null, body, channel, scope }),
      })
      setValidation(checked)
      const next = await requestJson<PreviewPayload>("/api/mca/comms/templates/preview", {
        method: "POST",
        body: JSON.stringify({
          templateId: selectedId,
          subject: channel === "email" ? subject : null,
          body,
          channel,
          scope,
          dealId: synthetic ? undefined : dealId.trim() || undefined,
        }),
      })
      setPreview(next)
      if (next.publishBlocked) {
        setError(next.forbiddenVariables.length ? TEMPLATE_EDITOR_COPY.forbidden : TEMPLATE_EDITOR_COPY.unknown)
      }
    } catch (caught) {
      setError(errorMessage(caught, TEMPLATE_EDITOR_COPY.previewFailed))
    } finally {
      setBusy(undefined)
    }
  }

  const grouped = React.useMemo(() => {
    const groups: Record<VariableGroup, TemplateVariable[]> = { deal: [], business: [], owner: [], rep: [], offers: [], documents: [], uploads: [] }
    for (const item of variables) {
      if (item.aliasOf) continue
      groups[item.group].push(item)
    }
    return groups
  }, [variables])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Message templates</CardTitle>
        <CardDescription>
          Personalize merchant email and SMS with deal, owner, offer, and scoped upload variables. Unknown variables cannot be published.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            {TEMPLATE_EDITOR_COPY.loading}
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div className="space-y-2">
              <Button variant="outline" size="sm" onClick={resetComposer} disabled={Boolean(busy)}>
                <Plus className="size-4" />
                New template
              </Button>
              {!payload?.templates.length ? (
                <p className="text-sm text-muted-foreground">{TEMPLATE_EDITOR_COPY.empty}</p>
              ) : (
                <ul className="space-y-1">
                  {payload.templates.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`w-full rounded-md border px-2 py-1.5 text-left text-sm ${selectedId === item.id ? "border-primary bg-muted" : ""}`}
                        onClick={() => void openTemplate(item.id)}
                        disabled={Boolean(busy)}
                      >
                        <span className="block font-medium">{item.name}</span>
                        <span className="text-xs text-muted-foreground">{item.channel} · {item.scope}{item.published ? " · published" : " · draft"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="template-name">Name</Label>
                  <Input id="template-name" value={name} onChange={(event) => setName(event.target.value)} aria-label="Template name" disabled={Boolean(busy)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="template-channel">Channel</Label>
                  <select
                    id="template-channel"
                    aria-label="Template channel"
                    className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={channel}
                    onChange={(event) => setChannel(event.target.value as Channel)}
                    disabled={Boolean(selectedId) || Boolean(busy)}
                  >
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="template-scope">Scope</Label>
                  <select
                    id="template-scope"
                    aria-label="Template scope"
                    className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={scope}
                    onChange={(event) => setScope(event.target.value as Scope)}
                    disabled={Boolean(selectedId) || Boolean(busy)}
                  >
                    <option value="merchant">Merchant</option>
                    <option value="followup">Follow-up</option>
                    <option value="request_info">Request info</option>
                    <option value="digest">Digest</option>
                  </select>
                </div>
                {channel === "email" && (
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="template-subject">Subject</Label>
                    <Input id="template-subject" value={subject} onChange={(event) => setSubject(event.target.value)} aria-label="Email subject" disabled={Boolean(busy)} />
                  </div>
                )}
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="template-body">Body</Label>
                  <Textarea
                    ref={bodyRef}
                    id="template-body"
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    rows={10}
                    aria-label="Template text"
                    disabled={Boolean(busy)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Variable picker</p>
                <div className="h-40 space-y-3 overflow-auto rounded-md border p-2">
                  {(Object.keys(grouped) as VariableGroup[]).map((group) => (
                    <div key={group}>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">{GROUP_LABEL[group]}</p>
                      <div className="flex flex-wrap gap-1">
                        {grouped[group].map((item) => (
                          <Button
                            key={item.name}
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7"
                            onClick={() => insertVariable(item.name)}
                            disabled={Boolean(busy)}
                            title={item.description}
                          >
                            {`{{${item.name}}}`}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void saveDraft()} disabled={Boolean(busy) || !gate.saveEnabled} aria-label="Save draft">
                  {busy === "save" || busy === "create" ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
                  Save draft
                </Button>
                <Button onClick={() => void publish()} disabled={Boolean(busy) || !gate.publishEnabled} aria-label="Publish template">
                  {busy === "publish" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  Publish
                </Button>
              </div>

              <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                <Input
                  value={dealId}
                  onChange={(event) => setDealId(event.target.value)}
                  placeholder="Preview deal ID"
                  aria-label="Preview deal ID"
                  disabled={Boolean(busy)}
                />
                <Button variant="outline" onClick={() => void runPreview(false)} disabled={Boolean(busy)} aria-label="Preview against deal">
                  {busy === "preview" ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
                  Preview deal
                </Button>
                <Button variant="outline" onClick={() => void runPreview(true)} disabled={Boolean(busy)} aria-label="Preview synthetic example">
                  <MessageSquareText className="size-4" />
                  Preview synthetic example
                </Button>
              </div>

              {preview && (
                <div className="space-y-2 rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{preview.synthetic ? "Synthetic preview" : "Deal preview"}</Badge>
                    {preview.publishBlocked && <Badge variant="destructive">Publish blocked</Badge>}
                  </div>
                  {preview.subject && <p><span className="text-muted-foreground">Subject</span> · {preview.subject}</p>}
                  <pre className="whitespace-pre-wrap font-sans">{preview.text}</pre>
                </div>
              )}

              {versions.length > 0 && (
                <div className="space-y-1">
                  <p className="flex items-center gap-1 text-sm font-medium"><History className="size-4" /> Version history</p>
                  <ul className="space-y-1 text-sm">
                    {versions.map((item) => (
                      <li key={item.id} className="flex items-center justify-between rounded-md border px-2 py-1">
                        <span>v{item.version}</span>
                        <span className="text-muted-foreground">{item.published ? "Published" : "Draft"} · {item.createdAt}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="size-4" />
            {error}
          </p>
        )}
        {message && !error && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4" />
            {message}
          </p>
        )}
        {!loading && gate.phase === "validation" && !error && (
          <p className="text-sm text-muted-foreground">{gate.reason}</p>
        )}
      </CardContent>
    </Card>
  )
}
