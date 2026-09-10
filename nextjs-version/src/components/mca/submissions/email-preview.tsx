"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Loader2, Mail, Paperclip } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { RequestError, requestJson } from "@/lib/mca/client"

type EmailTemplate = {
  id: string
  funderId: string | null
  subjectTemplate: string
  bodyTemplate: string
  prefix: string
  ccOriginator: boolean
  ccCloser: boolean
  persisted: boolean
}

type TemplateList = {
  templates: EmailTemplate[]
  funders: Array<{ id: string; legalName: string; nickname?: string }>
  defaults: { subjectTemplate: string; bodyTemplate: string }
  canManage: boolean
}

type PreviewItem = {
  funderId: string
  funderName: string
  fromName: string
  fromAddress: string
  to: string[]
  cc: string[]
  replyTo: string
  subject: string
  body: string
  workspacePrefix: string
  funderPrefix: string
  signature: string
  attachments: Array<{ documentId: string; filename: string; checksum: string; byteLength: number; category: string }>
  error?: string
}

type PreviewPayload = {
  dealId: string
  delivery: "preview"
  sender: { id: string; fromName: string; fromAddress: string }
  previews: PreviewItem[]
  canManage: boolean
}

const WORKSPACE_SCOPE = "workspace"

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof RequestError) {
    const fields = caught.fieldErrors ? Object.values(caught.fieldErrors).flat().filter(Boolean) : []
    if (fields.length) return fields.join(" ")
    return caught.message
  }
  return caught instanceof Error ? caught.message : fallback
}

function funderLabel(funder: { legalName: string; nickname?: string }): string {
  return funder.nickname || funder.legalName
}

function emptyForm(defaults: TemplateList["defaults"], funderId: string | null, current?: EmailTemplate) {
  return {
    funderId,
    subjectTemplate: current?.subjectTemplate || defaults.subjectTemplate,
    bodyTemplate: current?.bodyTemplate || defaults.bodyTemplate,
    prefix: current?.prefix ?? "",
    ccOriginator: current?.ccOriginator ?? false,
    ccCloser: current?.ccCloser ?? false,
  }
}

export function EmailPreview({ dealId }: { dealId?: string }) {
  const [templates, setTemplates] = React.useState<TemplateList>()
  const [preview, setPreview] = React.useState<PreviewPayload>()
  const [scope, setScope] = React.useState(WORKSPACE_SCOPE)
  const [form, setForm] = React.useState({
    funderId: null as string | null,
    subjectTemplate: "",
    bodyTemplate: "",
    prefix: "",
    ccOriginator: false,
    ccCloser: false,
  })
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const [canManage, setCanManage] = React.useState(false)

  const applyScope = React.useCallback((list: TemplateList, nextScope: string) => {
    const funderId = nextScope === WORKSPACE_SCOPE ? null : nextScope
    const current = list.templates.find((item) => (item.funderId ?? null) === funderId)
    setForm(emptyForm(list.defaults, funderId, current))
  }, [])

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      let list: TemplateList | undefined
      try {
        list = await requestJson<TemplateList>("/api/mca/submissions/email")
        setTemplates(list)
        setCanManage(list.canManage)
      } catch (caught) {
        if (!(caught instanceof RequestError && caught.status === 403)) {
          throw caught
        }
        setTemplates(undefined)
        setCanManage(false)
      }
      if (dealId) {
        const next = await requestJson<PreviewPayload>("/api/mca/submissions/email/preview", {
          method: "POST",
          body: JSON.stringify({ dealId }),
        })
        setPreview(next)
        setCanManage(next.canManage || Boolean(list?.canManage))
      }
    } catch (caught) {
      setError(errorMessage(caught, "Submission email preview could not be loaded."))
    } finally {
      setLoading(false)
    }
  }, [dealId])

  React.useEffect(() => { void load() }, [load])

  React.useEffect(() => {
    if (templates) applyScope(templates, scope)
  }, [applyScope, scope, templates])

  function changeScope(next: string) {
    setScope(next)
    if (templates) applyScope(templates, next)
  }

  async function saveTemplate() {
    if (!form.subjectTemplate.trim()) {
      setError("Enter a subject template.")
      return
    }
    if (!form.bodyTemplate.trim()) {
      setError("Enter a body template.")
      return
    }
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    try {
      await requestJson("/api/mca/submissions/email", {
        method: "PUT",
        body: JSON.stringify({
          funderId: form.funderId,
          subjectTemplate: form.subjectTemplate,
          bodyTemplate: form.bodyTemplate,
          prefix: form.prefix,
          ccOriginator: form.ccOriginator,
          ccCloser: form.ccCloser,
        }),
      })
      setMessage("Template saved. New submissions use the updated prefix, copy, and CC flags. Prior attempts stay unchanged.")
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "The email template could not be saved."))
    } finally {
      setBusy(false)
    }
  }

  const funders = templates?.funders ?? preview?.previews.map((item) => ({ id: item.funderId, legalName: item.funderName })) ?? []
  const previews = preview?.previews ?? []

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Mail className="size-5" />Submission email</CardTitle>
          <CardDescription>
            Preview recipient, CC, reply-to, and attachments for each funder before send. Originator and closer copies are separate from merchant follow-up.
          </CardDescription>
        </div>
        <Button onClick={() => void load()} disabled={loading || busy} variant="outline" aria-label="Refresh email preview">
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
          {loading ? "Loading…" : "Refresh preview"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading submission email preview…</p>}
        {error && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</p>}
        {message && <p role="status" className="flex items-start gap-2 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{message}</p>}

        {canManage && templates && (
          <div className="space-y-3 rounded-lg border p-3">
            <p className="text-sm font-medium">Template</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="email-template-scope">Applies to</Label>
                <Select value={scope} onValueChange={changeScope} disabled={busy}>
                  <SelectTrigger id="email-template-scope" aria-label="Template scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={WORKSPACE_SCOPE}>Workspace default</SelectItem>
                    {funders.map((funder) => (
                      <SelectItem key={funder.id} value={funder.id}>{funderLabel(funder)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email-template-prefix">{scope === WORKSPACE_SCOPE ? "Workspace prefix" : "Funder prefix"}</Label>
                <Input
                  id="email-template-prefix"
                  value={form.prefix}
                  onChange={(event) => setForm((current) => ({ ...current, prefix: event.target.value }))}
                  disabled={busy}
                  maxLength={80}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email-template-subject">Subject template</Label>
              <Input
                id="email-template-subject"
                value={form.subjectTemplate}
                onChange={(event) => setForm((current) => ({ ...current, subjectTemplate: event.target.value }))}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email-template-body">Body template</Label>
              <Textarea
                id="email-template-body"
                value={form.bodyTemplate}
                onChange={(event) => setForm((current) => ({ ...current, bodyTemplate: event.target.value }))}
                disabled={busy}
                rows={6}
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.ccOriginator}
                  onCheckedChange={(value) => setForm((current) => ({ ...current, ccOriginator: value === true }))}
                  aria-label="CC originator"
                />
                CC originator
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.ccCloser}
                  onCheckedChange={(value) => setForm((current) => ({ ...current, ccCloser: value === true }))}
                  aria-label="CC closer"
                />
                CC closer
              </label>
            </div>
            <Button onClick={() => void saveTemplate()} disabled={busy} aria-label="Save email template">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {busy ? "Saving…" : "Save template"}
            </Button>
          </div>
        )}

        {dealId && !loading && !error && previews.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No email funders are available to preview on this deal.
          </div>
        )}

        {previews.length > 0 && (
          <ul className="space-y-3">
            {previews.map((item) => (
              <li key={item.funderId || item.funderName} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{item.funderName}</p>
                  <Badge variant="outline">Email</Badge>
                  {item.workspacePrefix ? <Badge variant="secondary">WS {item.workspacePrefix}</Badge> : null}
                  {item.funderPrefix ? <Badge variant="secondary">{item.funderPrefix}</Badge> : null}
                </div>
                {item.error ? (
                  <p className="text-sm text-destructive">{item.error}</p>
                ) : (
                  <dl className="grid gap-1 text-sm">
                    <div><span className="text-muted-foreground">To</span> · {item.to.join(", ") || "—"}</div>
                    <div><span className="text-muted-foreground">CC</span> · {item.cc.join(", ") || "None"}</div>
                    <div><span className="text-muted-foreground">Reply-to</span> · {item.replyTo || "—"}</div>
                    <div><span className="text-muted-foreground">From</span> · {item.fromName} &lt;{item.fromAddress}&gt;</div>
                    <div><span className="text-muted-foreground">Subject</span> · {item.subject}</div>
                    <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{item.body}</pre>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      {item.attachments.length === 0 ? (
                        <p>No attachments on this package.</p>
                      ) : item.attachments.map((document) => (
                        <p key={document.documentId} className="flex items-center gap-1">
                          <Paperclip className="size-3" />
                          {document.filename} · {document.category} · {document.checksum.slice(0, 12)}
                        </p>
                      ))}
                    </div>
                  </dl>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
