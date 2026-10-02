"use client"

import { useEffect, useRef, useState } from "react"
import { PLATFORM_REFRESH_EVENT } from "@/lib/mca/platform-refresh"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { PlatformSection, PlatformStatus } from "@/components/mca/platform/presentation"
import type { RoadmapItem } from "@/lib/mca/roadmap-admin"

type Fields = Pick<RoadmapItem, "title" | "summary" | "status" | "sort_order">
const blank: Fields = { title: "", summary: "", status: "planned", sort_order: 0 }

export function RoadmapEditor({ initialItems }: { initialItems: RoadmapItem[] }) {
  const [items, setItems] = useState(initialItems)
  const [draft, setDraft] = useState<Fields>(blank)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const reading = useRef<Promise<void> | null>(null)
  const [snapshotAt, setSnapshotAt] = useState<string>()

  async function refresh() {
    if (reading.current) return reading.current
    reading.current = (async () => {
      try {
        const response = await fetch("/api/platform/roadmap", { cache: "no-store" })
        if (!response.ok) throw new Error("Could not load roadmap items.")
        setItems(await response.json() as RoadmapItem[])
        setSnapshotAt(response.headers.get("X-MCA-Snapshot-At") ?? new Date().toISOString())
        setError("")
      } finally { reading.current = null }
    })()
    return reading.current
  }
  useEffect(() => {
    const read = () => { if (!busy) void refresh().catch(() => setError("Roadmap snapshot is stale; refresh failed.")) }
    window.addEventListener(PLATFORM_REFRESH_EVENT, read)
    return () => window.removeEventListener(PLATFORM_REFRESH_EVENT, read)
  }, [busy])
  async function save(path: string, method: string, body: object) {
    setBusy(true); setError("")
    try {
      await reading.current
      const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      if (!response.ok) {
        const data = await response.json() as { error?: { message?: string } }
        throw new Error(data.error?.message || "Roadmap change failed.")
      }
      await refresh()
      return true
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Roadmap change failed."); return false }
    finally { setBusy(false) }
  }
  return <div className="space-y-6">
    {snapshotAt && <p className="text-xs text-muted-foreground">Database snapshot: <time dateTime={snapshotAt}>{snapshotAt}</time></p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <PlatformSection title="Create item"><form className="space-y-4" onSubmit={async event => { event.preventDefault(); if (await save("/api/platform/roadmap", "POST", draft)) setDraft(blank) }}>
      <FieldsEditor value={draft} onChange={setDraft} />
      <Button disabled={busy} type="submit">Create item</Button>
    </form></PlatformSection>
    {items.map(item => <ItemEditor key={item.id} item={item} busy={busy} save={save} />)}
  </div>
}

function FieldsEditor({ value, onChange }: { value: Fields; onChange: (value: Fields) => void }) {
  return <div className="grid gap-3">
    <Label className="grid gap-2">Title <Input required maxLength={120} value={value.title} onChange={event => onChange({ ...value, title: event.target.value })} /></Label>
    <Label className="grid gap-2">Summary <Textarea required maxLength={500} value={value.summary} onChange={event => onChange({ ...value, summary: event.target.value })} /></Label>
    <Label className="grid gap-2">Status <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={value.status} onChange={event => onChange({ ...value, status: event.target.value as Fields["status"] })}><option value="planned">Planned</option><option value="in_progress">In progress</option><option value="shipped">Shipped</option></select></Label>
    <Label className="grid gap-2">Sort order <Input type="number" min="0" step="1" required value={value.sort_order} onChange={event => onChange({ ...value, sort_order: Number(event.target.value) })} /></Label>
  </div>
}

function ItemEditor({ item, busy, save }: { item: RoadmapItem; busy: boolean; save: (path: string, method: string, body: object) => Promise<boolean> }) {
  const [draft, setDraft] = useState<Fields | null>(null)
  const [editedAt, setEditedAt] = useState<string | null>(null)
  const path = `/api/platform/roadmap/${item.id}`
  return <PlatformSection title={item.title}><form className="space-y-4" onSubmit={async event => { event.preventDefault(); if (await save(path, "PUT", { ...(draft ?? item), updated_at: editedAt ?? item.updated_at })) { setDraft(null); setEditedAt(null) } }}>
    <p className="flex items-center gap-2 text-sm text-muted-foreground">Publication: <PlatformStatus value={item.published ? "Published" : "Unpublished"} /></p>
    <FieldsEditor value={draft ?? item} onChange={value => { setEditedAt(editedAt ?? item.updated_at); setDraft(value) }} />
    <div className="flex flex-wrap gap-3">
      <Button disabled={busy} type="submit">Save changes</Button>
      <Button variant="outline" disabled={busy} type="button" onClick={() => void save(`${path}?action=${item.published ? "unpublish" : "publish"}`, "POST", { updated_at: item.updated_at })}>{item.published ? "Unpublish" : "Publish"}</Button>
      <Button variant="destructive" disabled={busy} type="button" onClick={() => { if (window.confirm("Delete this roadmap item?")) void save(path, "DELETE", { updated_at: item.updated_at }) }}>Delete item</Button>
    </div>
  </form></PlatformSection>
}
