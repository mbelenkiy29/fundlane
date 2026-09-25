"use client"

import * as React from "react"
import { AlertCircle, LoaderCircle, ShieldCheck, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RequestError, requestJson } from "@/lib/mca/client"

type ProtectionView = {
  settings: {
    enabled: boolean
    stampEnabled: boolean
    watermarkEnabled: boolean
    hasLogo: boolean
    logoSource: "document" | "workspace" | "none"
    logoDocumentId: string | null
  }
  canManage: boolean
}

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof RequestError) {
    const fields = caught.fieldErrors ? Object.values(caught.fieldErrors).flat().filter(Boolean) : []
    if (fields.length) return fields.join(" ")
    return caught.message
  }
  return caught instanceof Error ? caught.message : fallback
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("The logo file could not be read."))
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : ""
      const comma = result.indexOf(",")
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

export function DocumentProtectionCard() {
  const [view, setView] = React.useState<ProtectionView | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const fileInput = React.useRef<HTMLInputElement>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setView(await requestJson<ProtectionView>("/api/mca/submissions/document-protection"))
    } catch (caught) {
      setError(errorMessage(caught, "Document protection settings could not be loaded."))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  async function setEnabled(enabled: boolean) {
    if (!view?.canManage) return
    setSaving(true)
    setError("")
    try {
      setView(await requestJson<ProtectionView>("/api/mca/submissions/document-protection", {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }))
      toast.success(enabled ? "Document protection is on for outgoing submissions." : "Document protection is off.")
    } catch (caught) {
      setError(errorMessage(caught, "Document protection could not be updated."))
    } finally {
      setSaving(false)
    }
  }

  async function uploadLogo(file: File | undefined) {
    if (!file || !view?.canManage) return
    setSaving(true)
    setError("")
    try {
      const base64 = await fileToBase64(file)
      setView(await requestJson<ProtectionView>("/api/mca/submissions/document-protection/logo", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, mimeType: file.type || "image/png", base64 }),
      }))
      toast.success("Shop logo saved. Outgoing statements will use it as a watermark.")
    } catch (caught) {
      setError(errorMessage(caught, "The shop logo could not be uploaded."))
    } finally {
      setSaving(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  if (loading) {
    return <Card><CardContent className="flex min-h-36 items-center justify-center text-sm text-muted-foreground"><LoaderCircle className="mr-2 size-4 animate-spin" />Loading document protection</CardContent></Card>
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" />Document protection</CardTitle>
        <CardDescription>
          Stamp outgoing bank statements with the destination funder&apos;s name and watermark them with the shop logo. Originals stay unmodified in private storage.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div>}
        {!view?.canManage && <p className="text-sm text-muted-foreground">Only a workspace administrator can change document protection. You can still review the current setting.</p>}
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="document-protection-enabled" className="text-sm font-medium">Protect outgoing submissions</Label>
            <p className="text-xs text-muted-foreground">
              {view?.settings.enabled
                ? view.settings.watermarkEnabled
                  ? "Stamps and the shop-logo watermark are applied to outgoing statement copies."
                  : "Funder stamps are applied. Upload a shop logo to watermark outgoing copies."
                : "Outgoing packages use the original stored statements."}
            </p>
          </div>
          <Switch
            id="document-protection-enabled"
            checked={Boolean(view?.settings.enabled)}
            disabled={!view?.canManage || saving}
            onCheckedChange={(value) => void setEnabled(value)}
            aria-label="Protect outgoing submissions"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="shop-logo">Shop logo</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="shop-logo"
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg"
              disabled={!view?.canManage || saving}
              aria-label="Upload shop logo"
              onChange={(event) => void uploadLogo(event.target.files?.[0])}
            />
            <Button type="button" variant="outline" disabled={!view?.canManage || saving} onClick={() => fileInput.current?.click()}>
              {saving ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
              {view?.settings.hasLogo ? "Replace logo" : "Upload logo"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {view?.settings.hasLogo
              ? "A shop logo is on file and will watermark protected statement copies."
              : "Upload a PNG or JPEG logo. It is applied only to outgoing copies, never to the stored original."}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
