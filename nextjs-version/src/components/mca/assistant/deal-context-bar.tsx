"use client"

import { useEffect, useState } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { chatkitDealEntity, type ChatKitDealRef } from "@/lib/mca/assistant/chatkit-entities"
import type { AssistantDeal } from "./chatkit-session"

export async function searchDealEntities(query: string) {
  const response = await fetch(`/api/mca/deals?q=${encodeURIComponent(query)}`, { credentials: "same-origin" })
  if (!response.ok) return []
  const data = (await response.json()) as { deals: ChatKitDealRef[] }
  return data.deals.slice(0, 20).map(chatkitDealEntity)
}

export function DealContextBar({
  deal,
  onDealChange,
  includedDealId,
  onIncludedDealChange,
}: {
  deal: AssistantDeal
  onDealChange: (deal: AssistantDeal) => void
  includedDealId: string | null
  onIncludedDealChange: (id: string | null) => void
}) {
  const [query, setQuery] = useState("")
  const [fetched, setFetched] = useState<ChatKitDealRef[]>([])
  const matches = query.trim() ? fetched : []
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const abort = new AbortController()
    const timer = setTimeout(() => {
      void fetch(`/api/mca/deals?q=${encodeURIComponent(q)}`, { credentials: "same-origin", signal: abort.signal })
        .then((response) => response.json() as Promise<{ deals: ChatKitDealRef[] }>)
        .then((data) => {
          if (!abort.signal.aborted) setFetched(data.deals.slice(0, 8))
        })
        .catch(() => {
          if (!abort.signal.aborted) setFetched([])
        })
    }, 200)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [query])
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <label htmlFor="assistant-deal-search" className="text-xs font-medium text-muted-foreground">
        Find a deal
      </label>
      <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
        <input
          id="assistant-deal-search"
          className="h-8 w-full rounded-md border bg-background px-2 text-sm"
          placeholder="Search business name"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            onDealChange(null)
            onIncludedDealChange(null)
          }}
        />
        {!!matches.length && !deal && (
          <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover py-1 text-sm shadow-md">
            {matches.map((match) => (
              <li key={match.id}>
                <button
                  type="button"
                  className="w-full px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => {
                    onDealChange({ id: match.id, label: match.legalName?.trim() || match.displayId || match.id })
                    onIncludedDealChange(match.id)
                    setQuery("")
                    setFetched([])
                  }}
                >
                  {match.legalName?.trim() || match.displayId || match.id}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {deal && (
        <>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={includedDealId === deal.id}
              onChange={(event) => onIncludedDealChange(event.target.checked ? deal.id : null)}
            />
            Include {deal.label}
          </label>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Clear selected deal"
            onClick={() => {
              onDealChange(null)
              onIncludedDealChange(null)
            }}
          >
            <X className="size-3.5" />
          </Button>
        </>
      )}
    </div>
  )
}
