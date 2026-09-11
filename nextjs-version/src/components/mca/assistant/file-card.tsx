"use client"
import Image from "next/image"
import { useEffect, useState } from "react"
import { Download, Eye, FileText, Loader2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { assistantJson } from "./credit-balance"
import type { AssistantFile } from "@/lib/mca/assistant/experience-contracts"
type Preview =
  | { kind: "text"; text: string }
  | { kind: "tables"; sheets: { name: string; rows: unknown[][] }[] }
  | { kind: "pdf" | "image" }
export const fileUrl = (id: string) =>
  `/api/mca/assistant/files/${encodeURIComponent(id)}`
export function FileCard({
  file,
  onUse,
  onDelete
}: {
  file: AssistantFile
  onUse?: (file: AssistantFile) => void
  onDelete?: () => void
}) {
  const [open, setOpen] = useState(false),
    [preview, setPreview] = useState<Preview | null>(null),
    [blob, setBlob] = useState(""),
    [error, setError] = useState("")
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    let url = ""
    void assistantJson<Preview>(`${fileUrl(file.id)}?preview=1`, {
      signal: controller.signal
    })
      .then(async (p) => {
        if (p.kind === "pdf" || p.kind === "image") {
          const response = await fetch(fileUrl(file.id), {
            signal: controller.signal
          })
          if (!response.ok) throw new Error("This file is no longer available.")
          const data = await response.blob()
          if (controller.signal.aborted) return
          url = URL.createObjectURL(data)
          setBlob(url)
        }
        setPreview(p)
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message)
      })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
      setPreview(null)
      setBlob("")
      setError("")
    }
  }, [open, file.id])
  const ready = file.state === "ready"
  return (
    <>
      <div className="flex min-w-0 items-center gap-3 rounded-lg border bg-background p-3">
        <div className="rounded-md bg-muted p-2">
          <FileText className="size-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={file.name}>
            {file.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {(file.bytes / 1024).toFixed(0)} KB ·{" "}
            {ready
              ? `Expires ${new Date(file.expiresAt).toLocaleDateString()}`
              : file.state}
            {file.parentId ? " · Revised version" : ""}
          </p>
        </div>
        {ready && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Preview ${file.name}`}
              onClick={() => setOpen(true)}
            >
              <Eye className="size-4" />
            </Button>
            <Button asChild size="icon" variant="ghost">
              <a
                href={fileUrl(file.id)}
                download
                aria-label={`Download ${file.name}`}
              >
                <Download className="size-4" />
              </a>
            </Button>
            {onUse && (
              <Button size="sm" variant="outline" onClick={() => onUse(file)}>
                Attach
              </Button>
            )}
          </div>
        )}
        {onDelete && ready && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Delete ${file.name}`}
            onClick={() =>
              void assistantJson(fileUrl(file.id), { method: "DELETE" })
                .then(onDelete)
                .catch((e) => setError(e.message))
            }
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      {error && !open && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="break-all pr-5">{file.name}</DialogTitle>
            <DialogDescription>
              Private preview. Office previews show text and table content;
              download the original for its full layout.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert">{error}</p>
          ) : !preview ? (
            <Loader2 className="mx-auto my-10 size-5 motion-safe:animate-spin" />
          ) : preview.kind === "text" ? (
            <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-4 text-sm">
              {preview.text}
            </pre>
          ) : preview.kind === "tables" ? (
            <div className="max-h-[60dvh] space-y-5 overflow-auto">
              {preview.sheets.map((s) => (
                <section key={s.name}>
                  <h3 className="mb-2 font-medium">{s.name}</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <tbody>
                        {s.rows.map((r, i) => (
                          <tr key={i}>
                            {r.slice(0, 50).map((v, j) => (
                              <td key={j} className="border p-2">
                                {String(v ?? "")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </div>
          ) : preview.kind === "pdf" ? (
            <iframe
              sandbox=""
              src={blob}
              title={`PDF preview: ${file.name}`}
              className="h-[60dvh] w-full rounded border"
            />
          ) : blob ? (
            <div className="flex justify-center">
              <Image
                unoptimized
                width={1200}
                height={900}
                src={blob}
                alt={file.name}
                className="max-h-[60dvh] max-w-full object-contain"
              />
            </div>
          ) : null}
          <Button asChild variant="outline">
            <a href={fileUrl(file.id)} download>
              <Download className="size-4" />
              Download original
            </a>
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
