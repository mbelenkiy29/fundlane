"use client"

import * as React from "react"
import { AlertTriangle, Download, FlaskConical, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { FunderRecord } from "@/lib/mca/funders/contracts"
import { SANDBOX_WARNING } from "@/lib/mca/sandbox/labels"

interface SampleStatement {
  id: string
  filename: string
  period: string
  merchantName: string
  description: string
}

interface SandboxStatus {
  enabled: boolean
  warning: string
  funder: FunderRecord | null
  statements: SampleStatement[]
}

export function SandboxFunderCard({ canManage, onChange }: { canManage: boolean; onChange?: () => void }) {
  const [status, setStatus] = React.useState<SandboxStatus>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")

  const load = React.useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setStatus(await requestJson<SandboxStatus>("/api/mca/sandbox"))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The sandbox funder could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  async function toggle(enabled: boolean) {
    if (!canManage) return
    setBusy(true)
    setError("")
    try {
      const next = await requestJson<SandboxStatus>("/api/mca/sandbox", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      })
      setStatus(next)
      toast.success(enabled ? "Sandbox funder enabled for this workspace" : "Sandbox funder turned off")
      onChange?.()
    } catch (caught) {
      setError(caught instanceof RequestError ? caught.message : "The sandbox funder could not be updated.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <FlaskConical className="size-5 text-amber-700" />
              Sandbox demo funder
              <Badge variant="outline" className="border-amber-600 text-amber-800">SANDBOX — not a real lender</Badge>
            </CardTitle>
            <CardDescription>{status?.warning ?? SANDBOX_WARNING}</CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm">{status?.enabled ? "Enabled in this workspace" : "Off"}</span>
            <Switch
              checked={Boolean(status?.enabled)}
              disabled={!canManage || busy || loading}
              onCheckedChange={(enabled) => void toggle(enabled)}
              aria-label="Enable sandbox demo funder"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />Loading sandbox…
          </p>
        ) : null}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="flex items-start gap-2 rounded-md border border-amber-600/30 bg-background/70 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" />
          <p>
            Submissions to this funder stay inside the current workspace and return a synthetic offer or decline.
            They never send email, SMS, or external HTTP. Other workspaces cannot see this funder.
          </p>
        </div>
        {status?.funder ? (
          <p className="text-sm">
            Directory name: <span className="font-medium">{status.funder.legalName}</span>
            {status.funder.active ? "" : " (inactive)"}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Enable the sandbox to add a clearly labeled demo funder to this workspace only.</p>
        )}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Synthetic sample bank statements</h3>
          <p className="text-xs text-muted-foreground">
            Use these PDFs for upload and underwriting tests. Every file is stamped SYNTHETIC and is not a real account.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(status?.statements ?? []).map((statement) => (
              <a
                key={statement.id}
                href={`/api/mca/sandbox/statements/${statement.id}`}
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted/50"
              >
                <span>
                  <span className="block font-medium">{statement.merchantName}</span>
                  <span className="block text-xs text-muted-foreground">{statement.period} · synthetic PDF</span>
                </span>
                <Download className="size-4 shrink-0" />
              </a>
            ))}
          </div>
        </div>
        {!canManage ? <p className="text-sm text-muted-foreground">Only workspace admins can enable or disable the sandbox funder.</p> : null}
      </CardContent>
    </Card>
  )
}
