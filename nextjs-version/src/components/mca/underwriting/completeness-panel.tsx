"use client"

import * as React from "react"
import { ClipboardCheck, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requestJson } from "@/lib/mca/client"
import type { CompletenessFinding, CompletenessResult } from "@/lib/mca/underwriting/contracts"

type CompletenessPayload = {
  result: CompletenessResult | null
  events?: Array<{ id: string; completenessVersion: number; ready: boolean; createdAt: string }>
  requiredStatementMonths?: number
}

function missingMonths(findings: CompletenessFinding[]): CompletenessFinding[] {
  return findings.filter((finding) => finding.code.startsWith("missing_statement_"))
}

export function CompletenessPanel({ dealId }: { dealId: string }) {
  const [payload, setPayload] = React.useState<CompletenessPayload>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      setPayload(await requestJson<CompletenessPayload>(`/api/mca/underwriting/completeness/${encodeURIComponent(dealId)}`))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Completeness could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [dealId])

  React.useEffect(() => { void load() }, [load])

  async function rerun() {
    setBusy(true)
    setError(undefined)
    try {
      await requestJson<CompletenessResult>(`/api/mca/underwriting/completeness/${encodeURIComponent(dealId)}`, { method: "POST", body: "{}" })
      setPayload(await requestJson<CompletenessPayload>(`/api/mca/underwriting/completeness/${encodeURIComponent(dealId)}`))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Completeness check failed.")
    } finally {
      setBusy(false)
    }
  }

  const result = payload?.result
  const gaps = result ? missingMonths(result.findings) : []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ClipboardCheck className="size-5" />Document completeness</CardTitle>
        <CardDescription>Readiness depends on a clean application and the last {payload?.requiredStatementMonths ?? 3} checking-statement months, not on application field completeness.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void rerun()} disabled={loading || busy} aria-label="Rerun completeness check">
            <RefreshCw className="size-4" />{busy ? "Checking…" : "Rerun check"}
          </Button>
          {result && <Badge variant={result.ready ? "default" : "destructive"}>{result.ready ? "Ready" : "Not ready"}</Badge>}
        </div>
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading completeness…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!loading && !error && !result && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No completeness check yet. Run a check after uploading the application and recent statements.
          </div>
        )}
        {result && (
          <div className="space-y-3">
            <p role="status" className="text-sm">
              {result.ready
                ? "Required documents are present. This deal can proceed independently of draft field completeness."
                : "This deal is not ready. Resolve the named gaps below, then rerun."}
            </p>
            {gaps.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {gaps.map((finding) => (
                  <li key={finding.code}>Missing statement: {finding.period ?? finding.code.replace("missing_statement_", "")}</li>
                ))}
              </ul>
            )}
            {result.findings.length > 0 && (
              <ul className="space-y-1 text-sm">
                {result.findings.map((finding) => (
                  <li key={`${finding.code}:${finding.documentId ?? ""}`}>{finding.message}</li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">Check version {result.version} · {new Date(result.checkedAt).toLocaleString()}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
