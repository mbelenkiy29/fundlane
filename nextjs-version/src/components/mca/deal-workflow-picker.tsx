"use client"

import { useEffect, useState, type ReactNode } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { DEAL_STATUS_LABELS, type DealListItem, type DealListResponse } from "@/lib/mca/deals/schema"

export function DealWorkflowPicker({ children }: { children: (deal: DealListItem, refresh: () => void) => ReactNode }) {
  const router = useRouter()
  const params = useSearchParams()
  const selectedId = params.get("dealId") ?? ""
  const [deals, setDeals] = useState<DealListItem[]>([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void fetch("/api/mca/deals", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error?.message ?? "Unable to load deals.")
        setDeals((result as DealListResponse).deals)
        setError(null)
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load deals.")
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reload])

  function select(id: string) {
    const next = new URLSearchParams(params.toString())
    if (id) next.set("dealId", id)
    else next.delete("dealId")
    router.replace(`/offers${next.size ? `?${next}` : ""}`, { scroll: false })
  }

  const selected = deals.find((deal) => deal.id === selectedId)
  const matches = deals.filter((deal) => `${deal.legalName} ${deal.dbaName ?? ""} ${deal.displayId}`.toLowerCase().includes(query.toLowerCase()))

  if (loading) return <div aria-label="Loading deals" className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-56 w-full" /></div>
  if (error) return <div role="alert" className="rounded-lg border p-5"><p>{error}</p><Button variant="outline" className="mt-3" onClick={() => { setLoading(true); setReload((value) => value + 1) }}>Retry loading deals</Button></div>
  if (!deals.length) return <div className="rounded-lg border border-dashed p-8 text-center"><p>No deals are available yet.</p><Button asChild className="mt-4"><Link href="/pipeline">Open pipeline</Link></Button></div>

  return <div className="space-y-5">
    <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
      <div className="space-y-2"><Label htmlFor="workflow-deal-search">Find a deal</Label><Input id="workflow-deal-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Business name or deal number" /></div>
      <div className="space-y-2"><Label htmlFor="workflow-deal">Deal</Label><select id="workflow-deal" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={selectedId} onChange={(event) => select(event.target.value)}><option value="">Choose a deal</option>{selected && !matches.some((deal) => deal.id === selected.id) && <option value={selected.id}>{selected.displayId} · {selected.legalName}</option>}{matches.map((deal) => <option key={deal.id} value={deal.id}>{deal.displayId} · {deal.legalName}</option>)}</select>{!matches.length && <p className="text-sm text-muted-foreground">No matching deals.</p>}</div>
    </div>
    {selected ? <div key={selected.id} className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-lg font-semibold">{selected.legalName}</h2><p className="text-sm text-muted-foreground">{selected.displayId} · {DEAL_STATUS_LABELS[selected.status]}</p></div><Button asChild variant="outline"><Link href={`/pipeline?deal=${encodeURIComponent(selected.id)}`}>Open deal</Link></Button></div>{children(selected, () => setReload((value) => value + 1))}</div> : <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{selectedId ? "This deal is unavailable. Choose an accessible deal." : "Choose a deal to compare offers and manage closing."}</p>}
  </div>
}
