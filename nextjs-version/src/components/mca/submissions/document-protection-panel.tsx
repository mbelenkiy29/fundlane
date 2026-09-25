"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RequestError, requestJson } from "@/lib/mca/client"

type LogoSource = "document" | "workspace" | "none"

type ProtectionSettings = {
  enabled: boolean
  hasLogo: boolean
  logoSource: LogoSource
  stampEnabled: boolean
  watermarkEnabled: boolean
  updatedAt: string | null
}

type ProtectionPayload = {
  settings: ProtectionSettings
  canManage: boolean
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof RequestError) {
    const fields = caught.fieldErrors ? Object.values(caught.fieldErrors).flat().filter(Boolean) : []
    if (fields.length) return fields.join(" ")
    return caught.message
  }
  return caught instanceof Error ? caught.message : fallback
}

function logoStatus(settings: ProtectionSettings): string {
  if (settings.logoSource === "document") return "Shop logo uploaded. Outgoing copies receive a corner watermark."
  if (settings.logoSource === "workspace") return "Using the workspace data-URI logo as the watermark."
  return "Upload a PNG or JPEG shop logo to watermark outgoing copies. Public logo URLs are not fetched."
}

async function fileToBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () => reject(reader.error ?? new Error("The logo file could not be read."))
    reader.readAsDataURL(file)
  })
  const encoded = dataUrl.split(",")[1]
  if (!encoded) throw new Error("The logo file could not be read.")
  return encoded
}

export function DocumentProtectionPanel() {
  const [payload, setPayload] = React.useState<ProtectionPayload>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<"save" | "logo">()
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const [forbidden, setForbidden] = React.useState(false)

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      setPayload(await requestJson<ProtectionPayload>("/api/mca/submissions/document-protection"))
      setForbidden(false)
    } catch (caught) {
      if (caught instanceof RequestError && caught.status === 403) {
        setForbidden(true)
        setPayload(undefined)
      } else {
        setError(errorMessage(caught, "Document protection settings could not be loaded."))
      }
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  async function setEnabled(enabled: boolean) {
    setBusy("save")
    setError(undefined)
    setMessage(undefined)
    try {
      const next = await requestJson<ProtectionPayload>("/api/mca/submissions/document-protection", {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      })
      setPayload(next)
      setMessage(enabled
        ? "Document protection is on. Outgoing statements are stamped with the destination funder name."
        : "Document protection is off. Outgoing submissions send the unmodified vault originals.")
    } catch (caught) {
      setError(errorMessage(caught, "Document protection could not be updated."))
    } finally {
      setBusy(undefined)
    }
  }

  async function uploadLogo(file?: File) {
    if (!file) return
    if (file.size > MAX_LOGO_BYTES) {
      setError("Upload a PNG or JPEG logo smaller than 2 MB.")
      return
    }
    const mimeType = file.type === "image/jpg" ? "image/jpeg" : file.type
    if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
      setError("Upload a PNG or JPEG shop logo.")
      return
    }
    setBusy("logo")
    setError(undefined)
    setMessage(undefined)
    try {
      const next = await requestJson<ProtectionPayload>("/api/mca/submissions/document-protection/logo", {
        method: "POST",
        body: JSON.stringify({
          filename: file.name,
          mimeType,
          base64: await fileToBase64(file),
        }),
      })
      setPayload(next)
      setMessage(next.settings.watermarkEnabled
        ? "Shop logo saved. Outgoing copies now include the watermark."
        : "Shop logo saved. Turn on document protection to apply it on outgoing copies.")
    } catch (caught) {
      setError(errorMessage(caught, "The shop logo could not be uploaded."))
    } finally {
      setBusy(undefined)
    }
  }

  const settings = payload?.settings
  const canManage = payload?.canManage === true

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" />Document protection</CardTitle>
        <CardDescription>
          Stamp outgoing bank statements with the destination funder name and watermark them with the shop logo. Vault originals stay unmodified.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading document protection…</p>}
        {forbidden && (
          <p className="text-sm text-muted-foreground">
            Only workspace administrators can turn on document protection or upload the shop logo.
          </p>
        )}
        {error && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</p>}
        {message && <p role="status" className="flex items-start gap-2 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{message}</p>}
        {settings && (
          <>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <Label htmlFor="document-protection-enabled" className="text-sm font-medium">Protect outgoing submissions</Label>
                <p className="text-xs text-muted-foreground">
                  {settings.enabled
                    ? settings.watermarkEnabled
                      ? "Stamps and the shop-logo watermark apply to outgoing copies only."
                      : "Funder-name stamps apply to outgoing copies. Upload a logo to add the watermark."
                    : "Outgoing packages currently use the unmodified vault files."}
                </p>
              </div>
              <Switch
                id="document-protection-enabled"
                checked={settings.enabled}
                disabled={!canManage || busy !== undefined}
                onCheckedChange={(value) => void setEnabled(value)}
                aria-label="Protect outgoing submissions"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="document-protection-logo">Shop logo</Label>
              <p className="text-xs text-muted-foreground">{logoStatus(settings)}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="document-protection-logo"
                  type="file"
                  accept="image/png,image/jpeg"
                  disabled={!canManage || busy !== undefined}
                  aria-label="Shop logo file"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.currentTarget.value = ""
                    void uploadLogo(file)
                  }}
                />
                {busy === "logo" && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Uploading logo…</p>}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
