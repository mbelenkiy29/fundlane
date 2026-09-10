"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

export function MerchantUploadPanel({ token }: { token: string }) {
  const [request, setRequest] = React.useState<{ requestLabel: string; destinationCategory: string; expiresAt: string; remainingUploads: number }>()
  const [file, setFile] = React.useState<File>()
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const [busy, setBusy] = React.useState(false)
  const key = React.useRef(crypto.randomUUID())
  React.useEffect(() => { fetch(`/api/mca/closing/merchant-upload/${encodeURIComponent(token)}`, { cache: "no-store" }).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message); setRequest(body) }).catch((caught) => setError(caught instanceof Error ? caught.message : "This upload link is unavailable.")) }, [token])
  async function upload() {
    if (!file) { setError("Choose a PDF, PNG, or JPEG file."); return }
    setBusy(true); setError(undefined)
    try { const form = new FormData(); form.set("file", file); form.set("idempotencyKey", key.current); const response = await fetch(`/api/mca/closing/merchant-upload/${encodeURIComponent(token)}`, { method: "POST", body: form }); const body = await response.json(); if (!response.ok) throw new Error(body.error?.message); setMessage(body.processingState === "clean" ? "Upload received and validated. Your representative can now verify it." : "Upload received. Your representative will review it after security scanning.") }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Upload failed. You can retry safely.") } finally { setBusy(false) }
  }
  return <Card className="w-full max-w-xl"><CardHeader><CardTitle>{request?.requestLabel ?? "Secure document upload"}</CardTitle><CardDescription>{request ? `Requested category: ${request.destinationCategory.replace(/_/g, " ")}. Link expires ${new Date(request.expiresAt).toLocaleString()}.` : "Validating this secure link…"}</CardDescription></CardHeader><CardContent className="space-y-4">{request && !message && <><Input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(event) => setFile(event.target.files?.[0])} /><Button onClick={upload} disabled={!file || busy}>{busy ? "Uploading…" : "Upload requested document"}</Button></>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{message && <p role="status" className="text-sm text-emerald-700">{message}</p>}<p className="text-xs text-muted-foreground">This link is scoped to one request and cannot browse or change the deal. Files are limited to PDF, PNG, and JPEG and are security-scanned.</p></CardContent></Card>
}
