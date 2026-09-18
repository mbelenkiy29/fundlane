import type { Entity } from "@openai/chatkit-react"

export type ChatKitDealRef = {
  id: string
  legalName?: string | null
  displayId?: string | null
}

export function chatkitDealEntity(deal: ChatKitDealRef): Entity {
  const title = deal.legalName?.trim() || deal.displayId?.trim() || deal.id
  return {
    id: deal.id,
    title,
    group: "Deals",
    icon: "suitcase",
    interactive: true,
    data: { href: `/deals?deal=${encodeURIComponent(deal.id)}` },
  }
}

export function chatkitDealHref(entity: Entity): string | null {
  const href = entity.data?.href?.trim()
  if (href?.startsWith("/deals?deal=")) return href
  if (entity.id) return `/deals?deal=${encodeURIComponent(entity.id)}`
  return null
}
