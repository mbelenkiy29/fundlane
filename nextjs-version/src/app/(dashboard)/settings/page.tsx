"use client"

import * as React from "react"
import { AlertCircle, Building2, LoaderCircle, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { requestJson } from "@/lib/mca/client"
import { DEALS_PAGE_TITLE } from "@/lib/mca/app-paths"
import type { SessionResponse, WorkspaceSettings } from "@/lib/mca/types"

const pageLabels: Record<keyof WorkspaceSettings["pageVisibility"], string> = {
  dashboard: "Home", deals: DEALS_PAGE_TITLE, users: "Team settings", reports: "Reports", payments: "Payments", workspace: "Workspace settings", integrations: "API keys",
}

export default function WorkspaceSettingsPage() {
  const [settings, setSettings] = React.useState<WorkspaceSettings | null>(null)
  const [canEdit, setCanEdit] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")

  const load = React.useCallback(async () => {
    setLoading(true); setError("")
    try {
      const [workspace, session] = await Promise.all([requestJson<WorkspaceSettings>("/api/workspace"), requestJson<SessionResponse>("/api/auth/session")])
      setSettings(workspace); setCanEdit(Boolean(session.permissions?.canManageWorkspace))
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Workspace settings could not be loaded.") }
    finally { setLoading(false) }
  }, [])
  React.useEffect(() => { void load() }, [load])

  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!settings) return
    setSaving(true); setError("")
    try {
      const updated = await requestJson<WorkspaceSettings>("/api/workspace", { method: "PATCH", body: JSON.stringify({ ...settings, ...(settings.seatLimitManaged ? { seatLimit: undefined } : {}) }) })
      setSettings(updated); toast.success("Workspace settings saved")
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Workspace settings could not be saved.") }
    finally { setSaving(false) }
  }

  if (loading) return <SettingsLoading label="Loading workspace settings" />
  if (!settings) return <SettingsError message={error} retry={load} />

  return <form onSubmit={save} className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Brokerage</h2><p className="text-sm text-muted-foreground">Details and capabilities shared by this workspace.</p></div><Button type="submit" disabled={!canEdit || saving}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}{saving ? "Saving" : "Save changes"}</Button></div>
    {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div>}
    {!canEdit && <div className="rounded-lg border bg-muted/50 p-3 text-sm text-muted-foreground">Only a super admin can change workspace configuration. You can still review the current settings.</div>}
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Building2 className="size-5" /> Workspace details</CardTitle><CardDescription>Used throughout the app and in time-sensitive activity records.</CardDescription></CardHeader><CardContent className="grid gap-5 sm:grid-cols-2">
      <div className="space-y-2"><Label htmlFor="brokerage-name">Brokerage name</Label><Input id="brokerage-name" value={settings.brokerageName} disabled={!canEdit} onChange={(e) => setSettings({ ...settings, brokerageName: e.target.value })} required minLength={2} /></div>
      <div className="space-y-2"><Label htmlFor="timezone">Timezone</Label><Select disabled={!canEdit} value={settings.timezone} onValueChange={(timezone) => setSettings({ ...settings, timezone })}><SelectTrigger id="timezone"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="America/New_York">Eastern time</SelectItem><SelectItem value="America/Chicago">Central time</SelectItem><SelectItem value="America/Denver">Mountain time</SelectItem><SelectItem value="America/Los_Angeles">Pacific time</SelectItem><SelectItem value="UTC">UTC</SelectItem></SelectContent></Select></div>
      <div className="space-y-2 sm:col-span-2"><Label htmlFor="logo-url">Logo URL</Label><Input id="logo-url" type="url" placeholder="https://example.com/logo.png" value={settings.logoUrl ?? ""} disabled={!canEdit} onChange={(e) => setSettings({ ...settings, logoUrl: e.target.value || null })} /><p className="text-xs text-muted-foreground">Use a square HTTPS image. Empty uses the MCA mark.</p></div>
      <div className="space-y-2"><Label htmlFor="seat-limit">Seat limit</Label><Input id="seat-limit" type="number" min={1} max={10000} value={settings.seatLimit} disabled={!canEdit || settings.seatLimitManaged} onChange={(e) => setSettings({ ...settings, seatLimit: Number(e.target.value) })} />{settings.seatLimitManaged && <a href="/settings/billing" className="text-sm underline">Manage seats in Plans &amp; Billing</a>}</div>
    </CardContent></Card>
    <div className="grid gap-5 xl:grid-cols-3">
      <Card><CardHeader><CardTitle>Features</CardTitle><CardDescription>Turn optional workspace capabilities on or off.</CardDescription></CardHeader><CardContent className="divide-y">
        {Object.entries(settings.featureFlags).map(([key, enabled]) => <SwitchRow key={key} label={key === "integrations" ? "API integrations" : key[0].toUpperCase() + key.slice(1)} description={key === "reports" ? "Company performance and financial reports" : key === "payments" ? "Payment pages and financial tables" : "Workspace API keys and integrations"} checked={enabled} disabled={!canEdit} onCheckedChange={(value) => setSettings({ ...settings, featureFlags: { ...settings.featureFlags, [key]: value } })} />)}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Page visibility</CardTitle><CardDescription>Hide pages from navigation and direct access. Role permissions still apply.</CardDescription></CardHeader><CardContent className="divide-y">
        {Object.entries(settings.pageVisibility).map(([key, visible]) => <SwitchRow key={key} label={pageLabels[key as keyof WorkspaceSettings["pageVisibility"]]} description={visible ? "Visible to permitted roles" : "Hidden for this workspace"} checked={visible} disabled={!canEdit || key === "workspace"} onCheckedChange={(value) => setSettings({ ...settings, pageVisibility: { ...settings.pageVisibility, [key]: value } })} />)}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Action visibility</CardTitle><CardDescription>Control individual buttons and financial data independently from pages.</CardDescription></CardHeader><CardContent className="divide-y">
        {Object.entries(settings.actionVisibility).map(([key, visible]) => <SwitchRow key={key} label={{ createDeal: "Create deals", exportDeals: "Export deals", inviteUsers: "Invite users", manageApiKeys: "Manage API keys", viewPaymentTable: "Payment table", viewCompanyFinancials: "Company financials" }[key] ?? key} description={visible ? "Available when the user role permits" : "Hidden and blocked by the server"} checked={visible} disabled={!canEdit} onCheckedChange={(value) => setSettings({ ...settings, actionVisibility: { ...settings.actionVisibility, [key]: value } })} />)}
      </CardContent></Card>
    </div>
  </form>
}

function SwitchRow({ label, description, ...props }: { label: string; description: string } & React.ComponentProps<typeof Switch>) {
  return <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"><div><Label className="text-sm font-medium">{label}</Label><p className="text-xs text-muted-foreground">{description}</p></div><Switch aria-label={`${label} visibility`} {...props} /></div>
}

function SettingsLoading({ label }: { label: string }) { return <div className="flex min-h-56 items-center justify-center rounded-xl border" role="status"><LoaderCircle className="mr-2 size-5 animate-spin" /> <span className="text-sm text-muted-foreground">{label}</span></div> }
function SettingsError({ message, retry }: { message: string; retry: () => void }) { return <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border p-6 text-center"><AlertCircle className="size-7 text-destructive" /><div><p className="font-medium">Workspace settings unavailable</p><p className="text-sm text-muted-foreground">{message}</p></div><Button variant="outline" onClick={retry}>Try again</Button></div> }
