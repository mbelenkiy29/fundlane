"use client"

import * as React from "react"
import { AlertCircle, Check, Clipboard, KeyRound, LoaderCircle, MoreHorizontal, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requestJson } from "@/lib/mca/client"
import { API_KEY_SCOPES, type ApiKeyCreated, type ApiKeyScope, type ApiKeySummary, type SessionResponse } from "@/lib/mca/types"

const scopeLabels: Record<ApiKeyScope, string> = { "deals:read": "Read deals", "deals:write": "Edit deals", "deals:export": "Export deals", "intake:write": "Submit intake", "workspace:read": "Read workspace" }

export default function ApiKeysPage() {
  const [keys, setKeys] = React.useState<ApiKeySummary[]>([])
  const [canManage, setCanManage] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [createOpen, setCreateOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [scopes, setScopes] = React.useState<ApiKeyScope[]>(["deals:read"])
  const [expiresAt, setExpiresAt] = React.useState("")
  const [rateLimit, setRateLimit] = React.useState(60)
  const [secret, setSecret] = React.useState<ApiKeyCreated | null>(null)
  const [pendingKey, setPendingKey] = React.useState<{ key: ApiKeySummary; action: "rotate" | "revoke" } | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true); setError("")
    try {
      const [result, session] = await Promise.all([requestJson<ApiKeySummary[] | { apiKeys: ApiKeySummary[] }>("/api/api-keys"), requestJson<SessionResponse>("/api/auth/session")])
      setKeys(Array.isArray(result) ? result : result.apiKeys); setCanManage(Boolean(session.permissions?.canManageApiKeys && session.permissions?.actions?.manageApiKeys))
    } catch (caught) { setError(caught instanceof Error ? caught.message : "API keys could not be loaded.") }
    finally { setLoading(false) }
  }, [])
  React.useEffect(() => { void load() }, [load])

  async function createKey(event: React.FormEvent) {
    event.preventDefault(); setSubmitting(true); setError("")
    try {
      const created = await requestJson<ApiKeyCreated>("/api/api-keys", { method: "POST", body: JSON.stringify({ name, scopes, expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : undefined, rateLimitPerMinute: rateLimit }) })
      setCreateOpen(false); setSecret(created); setName(""); setScopes(["deals:read"]); setExpiresAt(""); toast.success("API key created"); await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "API key could not be created.") }
    finally { setSubmitting(false) }
  }

  async function confirmAction() {
    if (!pendingKey) return
    setSubmitting(true)
    try {
      if (pendingKey.action === "rotate") {
        const rotated = await requestJson<ApiKeyCreated>(`/api/api-keys/${pendingKey.key.id}/rotate`, { method: "POST" }); setSecret(rotated); toast.success("API key rotated")
      } else { await requestJson(`/api/api-keys/${pendingKey.key.id}`, { method: "DELETE" }); toast.success("API key revoked") }
      setPendingKey(null); await load()
    } catch (caught) { toast.error(caught instanceof Error ? caught.message : "API key could not be updated") }
    finally { setSubmitting(false) }
  }

  async function copySecret() { if (!secret) return; await navigator.clipboard.writeText(secret.secret); toast.success("Secret copied") }

  if (loading) return <State title="Loading API keys" icon={<LoaderCircle className="animate-spin" />} />
  if (error && keys.length === 0) return <State title="API keys unavailable" detail={error} icon={<AlertCircle className="text-destructive" />} action={<Button variant="outline" onClick={load}>Try again</Button>} />

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">API keys</h2><p className="text-sm text-muted-foreground">Scoped access for trusted workspace integrations.</p></div>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogTrigger asChild><Button disabled={!canManage}><Plus /> Create key</Button></DialogTrigger><DialogContent><form onSubmit={createKey}><DialogHeader><DialogTitle>Create API key</DialogTitle><DialogDescription>The secret is shown once. Store it in a secure secrets manager.</DialogDescription></DialogHeader><div className="space-y-5 py-5"><div className="space-y-2"><Label htmlFor="key-name">Name</Label><Input id="key-name" placeholder="Production intake" value={name} onChange={(e) => setName(e.target.value)} required /></div><div className="space-y-3"><Label>Scopes</Label>{API_KEY_SCOPES.map((scope) => <label key={scope} className="flex items-center gap-3 text-sm"><Checkbox checked={scopes.includes(scope)} onCheckedChange={(checked) => setScopes((all) => checked ? [...all, scope] : all.filter((item) => item !== scope))} /><span>{scopeLabels[scope]} <span className="font-mono text-xs text-muted-foreground">{scope}</span></span></label>)}</div><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="key-expiry">Expires</Label><Input id="key-expiry" type="date" min={new Date().toISOString().slice(0, 10)} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /><p className="text-xs text-muted-foreground">Empty means no expiry.</p></div><div className="space-y-2"><Label htmlFor="rate-limit">Requests per minute</Label><Input id="rate-limit" type="number" min={1} max={10000} value={rateLimit} onChange={(e) => setRateLimit(Number(e.target.value))} /></div></div></div>{error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}<DialogFooter><Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" disabled={submitting || scopes.length === 0}>{submitting && <LoaderCircle className="animate-spin" />}Create key</Button></DialogFooter></form></DialogContent></Dialog>
    </div>
    <div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground"><ShieldAlert className="mr-2 inline size-4" />Keys are bound to this workspace. Revocation takes effect immediately; secrets never appear in URLs or activity logs.</div>
    {keys.length === 0 ? <State title="No API keys" detail="Create a scoped key when an integration is ready to connect." icon={<KeyRound />} action={canManage ? <Button onClick={() => setCreateOpen(true)}><Plus /> Create key</Button> : undefined} /> : <Card><CardContent className="p-0"><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Scopes</TableHead><TableHead>Last used</TableHead><TableHead>Expires</TableHead><TableHead>Rate limit</TableHead><TableHead className="w-12"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader><TableBody>{keys.map((key) => <TableRow key={key.id} className={key.revokedAt ? "opacity-60" : undefined}><TableCell><p className="font-medium">{key.name}</p><p className="font-mono text-xs text-muted-foreground">{key.prefix}••••••••</p>{key.revokedAt && <Badge variant="outline" className="mt-1">Revoked</Badge>}</TableCell><TableCell><div className="flex min-w-48 flex-wrap gap-1">{key.scopes.map((scope) => <Badge variant="secondary" key={scope}>{scope}</Badge>)}</div></TableCell><TableCell className="whitespace-nowrap text-sm">{formatDate(key.lastUsedAt, "Never")}</TableCell><TableCell className="whitespace-nowrap text-sm">{formatDate(key.expiresAt, "No expiry")}</TableCell><TableCell>{key.rateLimitPerMinute}/min</TableCell><TableCell>{canManage && !key.revokedAt && <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`Actions for ${key.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => setPendingKey({ key, action: "rotate" })}><RefreshCw /> Rotate</DropdownMenuItem><DropdownMenuItem className="text-destructive" onSelect={() => setPendingKey({ key, action: "revoke" })}><Trash2 /> Revoke</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}</TableCell></TableRow>)}</TableBody></Table></div></CardContent></Card>}
    <Dialog open={Boolean(secret)} onOpenChange={(open) => !open && setSecret(null)}><DialogContent><DialogHeader><DialogTitle>Copy your API secret</DialogTitle><DialogDescription>This is the only time the full secret will be displayed. You cannot recover it later.</DialogDescription></DialogHeader><div className="rounded-lg border bg-muted p-3 font-mono text-sm break-all" data-testid="api-key-secret">{secret?.secret}</div><DialogFooter><Button variant="outline" onClick={copySecret}><Clipboard /> Copy secret</Button><Button onClick={() => setSecret(null)}><Check /> I saved it</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(pendingKey)} onOpenChange={(open) => !open && setPendingKey(null)}><DialogContent><DialogHeader><DialogTitle>{pendingKey?.action === "rotate" ? "Rotate" : "Revoke"} {pendingKey?.key.name}?</DialogTitle><DialogDescription>{pendingKey?.action === "rotate" ? "The current secret will stop working immediately. A replacement secret will be shown once." : "Requests using this key will fail immediately. This action cannot be undone."}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setPendingKey(null)}>Cancel</Button><Button variant={pendingKey?.action === "revoke" ? "destructive" : "default"} disabled={submitting} onClick={confirmAction}>{submitting && <LoaderCircle className="animate-spin" />}{pendingKey?.action === "rotate" ? "Rotate key" : "Revoke key"}</Button></DialogFooter></DialogContent></Dialog>
  </div>
}

function formatDate(value: string | null, fallback: string) { return value ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value)) : fallback }
function State({ title, detail, icon, action }: { title: string; detail?: string; icon: React.ReactNode; action?: React.ReactNode }) { return <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border p-6 text-center"><span className="[&>svg]:size-7">{icon}</span><div><p className="font-medium">{title}</p>{detail && <p className="mt-1 text-sm text-muted-foreground">{detail}</p>}</div>{action}</div> }
