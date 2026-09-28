"use client"

import { useState } from "react"
import type { RoadmapItem } from "@/lib/mca/roadmap-admin"

type Fields = Pick<RoadmapItem, "title" | "summary" | "status" | "sort_order">
const blank: Fields = { title: "", summary: "", status: "planned", sort_order: 0 }

export function RoadmapEditor({ initialItems }: { initialItems: RoadmapItem[] }) {
  const [items, setItems] = useState(initialItems)
  const [draft, setDraft] = useState<Fields>(blank)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function refresh() {
    const response = await fetch("/api/platform/roadmap", { cache: "no-store" })
    if (!response.ok) throw new Error("Could not load roadmap items.")
    setItems(await response.json() as RoadmapItem[])
  }
  async function save(path: string, method: string, body: object) {
    setBusy(true); setError("")
    try {
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
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <form className="space-y-3 rounded border p-4" onSubmit={async event => { event.preventDefault(); if (await save("/api/platform/roadmap", "POST", draft)) setDraft(blank) }}>
      <h2 className="text-xl font-semibold">Create item</h2>
      <FieldsEditor value={draft} onChange={setDraft} />
      <button disabled={busy} className="rounded border px-3 py-2" type="submit">Create item</button>
    </form>
    {items.map(item => <ItemEditor key={item.id} item={item} busy={busy} save={save} />)}
  </div>
}

function FieldsEditor({ value, onChange }: { value: Fields; onChange: (value: Fields) => void }) {
  return <div className="grid gap-3">
    <label>Title <input className="block w-full rounded border p-2" required maxLength={120} value={value.title} onChange={event => onChange({ ...value, title: event.target.value })} /></label>
    <label>Summary <textarea className="block w-full rounded border p-2" required maxLength={500} value={value.summary} onChange={event => onChange({ ...value, summary: event.target.value })} /></label>
    <label>Status <select className="block rounded border p-2" value={value.status} onChange={event => onChange({ ...value, status: event.target.value as Fields["status"] })}><option value="planned">Planned</option><option value="in_progress">In progress</option><option value="shipped">Shipped</option></select></label>
    <label>Sort order <input className="block rounded border p-2" type="number" min="0" step="1" required value={value.sort_order} onChange={event => onChange({ ...value, sort_order: Number(event.target.value) })} /></label>
  </div>
}

function ItemEditor({ item, busy, save }: { item: RoadmapItem; busy: boolean; save: (path: string, method: string, body: object) => Promise<boolean> }) {
  const [draft, setDraft] = useState<Fields>(item)
  const path = `/api/platform/roadmap/${item.id}`
  return <form className="space-y-3 rounded border p-4" onSubmit={event => { event.preventDefault(); void save(path, "PUT", { ...draft, updated_at: item.updated_at }) }}>
    <p>Publication: {item.published ? "Published" : "Unpublished"}</p>
    <FieldsEditor value={draft} onChange={setDraft} />
    <div className="flex flex-wrap gap-3">
      <button disabled={busy} className="rounded border px-3 py-2" type="submit">Save changes</button>
      <button disabled={busy} className="rounded border px-3 py-2" type="button" onClick={() => void save(`${path}?action=${item.published ? "unpublish" : "publish"}`, "POST", { updated_at: item.updated_at })}>{item.published ? "Unpublish" : "Publish"}</button>
      <button disabled={busy} className="rounded border px-3 py-2" type="button" onClick={() => { if (window.confirm("Delete this roadmap item?")) void save(path, "DELETE", { updated_at: item.updated_at }) }}>Delete item</button>
    </div>
  </form>
}
